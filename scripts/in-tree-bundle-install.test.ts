/**
 * scripts/in-tree-bundle-install.ts, and how verify-drivers chooses between
 * an in-tree and an npm install for a compiled bundle.
 *
 * Every fixture lives under the OS temp dir, outside this repository, so the
 * repository's tsconfig.json `paths` can never resolve a `@crewhaus` import
 * for it: a passing import proves the link, nothing else. Every subprocess
 * gets its env passed explicitly.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "in-tree-bundle-install.ts");
const VERIFY = join(REPO, "scripts", "verify-drivers.ts");
const SHIM_DIR = join(REPO, "node_modules", ".cache", "crewhaus-driver-shim");
const BUN = process.execPath;
const BASE_ENV = { PATH: `${dirname(BUN)}:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir() };

let root: string;
let factory: string;
let bareFactory: string;
let counter = 0;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "in-tree-bundle-install-")));
  // A fixture checkout: built packages (`a` with a subpath export and every
  // kind of install edge, `b` reached only through `a`, `t` reached by no
  // edge), an app, and its own (empty) install.
  factory = join(root, "factory");
  writeJson(join(factory, "packages", "a", "package.json"), {
    name: "@crewhaus/a",
    type: "module",
    exports: { ".": "./index.ts", "./sub": "./sub.ts" },
    dependencies: { "@crewhaus/b": "workspace:*", "left-pad": "^1.3.0" },
    optionalDependencies: { "opt-x": "^1.0.0" },
    peerDependencies: { "peer-req": "*", "peer-opt": "*" },
    peerDependenciesMeta: { "peer-opt": { optional: true } },
    devDependencies: { "@crewhaus/zz-dev-only": "workspace:*", "dev-only": "^1.0.0" },
  });
  writeFileSync(join(factory, "packages", "a", "index.ts"), 'export const main = "a-main";\n');
  writeFileSync(
    join(factory, "packages", "a", "sub.ts"),
    'export const sub = "a-sub-from-checkout";\n',
  );
  // `b` asks for another left-pad range: the first one reached wins.
  writeJson(join(factory, "packages", "b", "package.json"), {
    name: "@crewhaus/b",
    type: "module",
    dependencies: { "left-pad": "^9.0.0", zod: "^3.0.0" },
  });
  writeJson(join(factory, "packages", "t", "package.json"), {
    name: "@crewhaus/t",
    type: "module",
  });
  // `c` needs a package the checkout does not have.
  writeJson(join(factory, "packages", "c", "package.json"), {
    name: "@crewhaus/c",
    dependencies: { "@crewhaus/zz-gone": "workspace:*" },
  });
  for (const pkg of ["a", "b", "t", "c"]) mkdirSync(join(factory, "packages", pkg, "dist"));
  // A package the checkout has not built.
  writeJson(join(factory, "packages", "unbuilt", "package.json"), { name: "@crewhaus/unbuilt" });
  writeJson(join(factory, "apps", "cli", "package.json"), { name: "crewhaus", type: "module" });
  mkdirSync(join(factory, "apps", "cli", "src"), { recursive: true });
  writeFileSync(join(factory, "apps", "cli", "src", "index.ts"), 'console.log("0.0.0-fixture");\n');
  mkdirSync(join(factory, "node_modules"), { recursive: true });
  // A built checkout without its own install.
  bareFactory = join(root, "bare-factory");
  writeJson(join(bareFactory, "packages", "a", "package.json"), { name: "@crewhaus/a" });
  mkdirSync(join(bareFactory, "packages", "a", "dist"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function bundle(manifest: unknown): { dir: string; text: string } {
  const dir = join(root, `bundle-${++counter}`);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(dir, "package.json"), text);
  return { dir, text };
}

const compiled = (dependencies: Record<string, string>) => ({
  name: "crewhaus-compiled-bundle",
  private: true,
  type: "module",
  dependencies,
});

function run(
  argv: string[],
  cwd: string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync([BUN, ...argv], {
    cwd,
    env: { ...BASE_ENV, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const lastLine = (s: string) => s.trim().split("\n").at(-1) ?? "";

/**
 * A stand-in for the real bun: records its argv and the package.json it was
 * given, then exits `code`. It exits 9 first if any `@crewhaus` name reaches
 * that argv or manifest. With `npm`, it also does what a registry install
 * would: a bun.lock, a third-party package, and real directories under
 * `node_modules/@crewhaus/` that a third-party package pulled in (`t`, which
 * the checkout has, and `npm-only`, which it does not). `extra` adds lines.
 */
function stubBun(
  code = 7,
  npm = false,
  extra = "",
): { bin: string; out: string; manifest: string } {
  const bin = join(root, `stub-bun-${++counter}.sh`);
  const out = join(root, `stub-argv-${counter}.txt`);
  const manifest = join(root, `stub-manifest-${counter}.json`);
  const guard = [
    'case "$*" in *@crewhaus*) exit 9 ;; esac',
    `if [ -f package.json ]; then cp package.json '${manifest}'; fi`,
    "if [ -f package.json ] && grep -q @crewhaus package.json; then exit 9; fi",
    "",
  ].join("\n");
  const fakeNpm = npm
    ? "printf 'lock\\n' > bun.lock\nmkdir -p node_modules/left-pad node_modules/@crewhaus/t/dist " +
      "node_modules/@crewhaus/npm-only\n"
    : "";
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n${guard}${fakeNpm}${extra}exit ${code}\n`,
    {
      mode: 0o755,
    },
  );
  return { bin, out, manifest };
}

const scratchLeft = (dir: string) =>
  readdirSync(dir).filter((f) => f.startsWith(".in-tree-install-"));
const isLinkTo = (at: string, pkg: string) =>
  lstatSync(at).isSymbolicLink() &&
  realpathSync(at) === realpathSync(join(factory, "packages", pkg));

describe("an in-tree install fetches only third-party packages, then links the checkout's packages", () => {
  test("the real install gets the closure's third-party packages and no @crewhaus name", () => {
    // @crewhaus/a is at a version npm never had: nothing may try to fetch it.
    const b = bundle(compiled({ "@crewhaus/a": "0.0.0-unreleased" }));
    const stub = stubBun(0, true);
    const r = run([SCRIPT, factory, stub.bin, "install"], b.dir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(readFileSync(stub.out, "utf8")).toBe("install\n");
    // Required peers count, optional peers and devDependencies do not, and
    // a range reached first wins over a later one.
    expect(JSON.parse(readFileSync(stub.manifest, "utf8"))).toEqual({
      name: "crewhaus-compiled-bundle-deps",
      private: true,
      dependencies: { "left-pad": "^1.3.0", "peer-req": "*", zod: "^3.0.0" },
      optionalDependencies: { "opt-x": "^1.0.0" },
    });
    // Its node_modules and bun.lock moved into the bundle; the scratch dir is gone.
    expect(readFileSync(join(b.dir, "bun.lock"), "utf8")).toBe("lock\n");
    expect(existsSync(join(b.dir, "node_modules", "left-pad"))).toBe(true);
    expect(scratchLeft(b.dir)).toEqual([]);
    expect(readFileSync(join(b.dir, "package.json"), "utf8")).toBe(b.text);
  });

  test("every package of the closure, and every entry the checkout has, becomes a link", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    const r = run([SCRIPT, factory, stubBun(0, true).bin, "install"], b.dir);
    expect(r.code).toBe(0);
    const scope = join(b.dir, "node_modules", "@crewhaus");
    // a (a dependency), b (reached through a), and t (a real directory the
    // install left, which the checkout has).
    for (const name of ["a", "b", "t"]) expect(isLinkTo(join(scope, name), name)).toBe(true);
    // One the checkout does not have stays, and the run names it.
    expect(lstatSync(join(scope, "npm-only")).isDirectory()).toBe(true);
    expect(r.stdout).toContain("[in-tree] not in the checkout, so from npm: @crewhaus/npm-only\n");
    expect(lastLine(r.stdout)).toBe(`[in-tree] linked 3 @crewhaus package(s) from ${factory}`);
    expect(readdirSync(scope).sort()).toEqual(["a", "b", "npm-only", "t"]);
  });

  test("the bundle's earlier node_modules is replaced, npm copies included", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    mkdirSync(join(b.dir, "node_modules", "@crewhaus", "a", "dist"), { recursive: true });
    mkdirSync(join(b.dir, "node_modules", "stale-pkg"));
    expect(run([SCRIPT, factory, stubBun(0, true).bin, "install"], b.dir).code).toBe(0);
    expect(isLinkTo(join(b.dir, "node_modules", "@crewhaus", "a"), "a")).toBe(true);
    expect(existsSync(join(b.dir, "node_modules", "stale-pkg"))).toBe(false);
  });

  test("an install that writes no bun.lock leaves none behind", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    writeFileSync(join(b.dir, "bun.lock"), "stale\n");
    expect(run([SCRIPT, factory, stubBun(0).bin, "install"], b.dir).code).toBe(0);
    expect(existsSync(join(b.dir, "bun.lock"))).toBe(false);
    expect(isLinkTo(join(b.dir, "node_modules", "@crewhaus", "a"), "a")).toBe(true);
  });

  test("a subpath export resolves from the checkout, not the npm copy", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    expect(run([SCRIPT, factory, stubBun(0, true).bin, "install"], b.dir).code).toBe(0);
    const r = run(["-e", 'import { sub } from "@crewhaus/a/sub"; console.log(sub);'], b.dir);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("a-sub-from-checkout");
  });

  test("a link from an earlier run is replaced", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    expect(run([SCRIPT, factory, stubBun(0).bin, "install"], b.dir).code).toBe(0);
    expect(run([SCRIPT, factory, stubBun(0).bin, "install"], b.dir).code).toBe(0);
    expect(realpathSync(join(b.dir, "node_modules", "@crewhaus", "a"))).toBe(
      realpathSync(join(factory, "packages", "a")),
    );
  });

  test("a failed real install fails with its code, and leaves the bundle as it was", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    writeFileSync(join(b.dir, "bun.lock"), "earlier\n");
    const r = run([SCRIPT, factory, stubBun(5, true).bin, "install"], b.dir);
    expect(r.code).toBe(5);
    expect(r.stdout).not.toContain("[in-tree]");
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
    expect(readFileSync(join(b.dir, "bun.lock"), "utf8")).toBe("earlier\n");
    expect(scratchLeft(b.dir)).toEqual([]);
  });

  test("an entry the checkout has but has not built is refused", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    const stub = stubBun(0, false, "mkdir -p node_modules/@crewhaus/unbuilt\n");
    const r = run([SCRIPT, factory, stub.bin, "install"], b.dir);
    expect(r.code).toBe(1);
    expect(lastLine(r.stderr)).toBe(
      `in-tree-bundle-install: @crewhaus/unbuilt has no dist/ in ${factory}: run \`bun run build\` in the factory checkout first`,
    );
  });
});

describe("anything else runs the real bun unchanged", () => {
  const cases: [string, unknown, string[]][] = [
    [
      "a manifest with another name (a cf-worker bundle)",
      { name: "my-worker", dependencies: {} },
      ["install"],
    ],
    // No dependencies, so the stub's guard (exit 9) stays quiet.
    ["install with more arguments", compiled({}), ["install", "--frozen-lockfile"]],
    ["another command", compiled({}), ["--env-file=/dev/null", "daemon.ts"]],
    ["a manifest that is not JSON", "{not json", ["install"]],
  ];
  // The stub's guard can fire: a cf-worker manifest that names a @crewhaus
  // package goes to the real bun as it is, and the stub refuses it.
  test("the stub refuses a manifest that names a @crewhaus package", () => {
    const b = bundle({ name: "my-worker", dependencies: { "@crewhaus/a": "0.8.3" } });
    expect(run([SCRIPT, factory, stubBun().bin, "install"], b.dir).code).toBe(9);
  });
  for (const [label, manifest, args] of cases) {
    test(label, () => {
      const b = typeof manifest === "string" ? bundle(null) : bundle(manifest);
      if (typeof manifest === "string") writeFileSync(join(b.dir, "package.json"), manifest);
      const stub = stubBun();
      const r = run([SCRIPT, factory, stub.bin, ...args], b.dir);
      expect(r.code).toBe(7);
      expect(readFileSync(stub.out, "utf8")).toBe(`${args.join("\n")}\n`);
      expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
    });
  }

  test("a directory without a package.json", () => {
    const dir = join(root, `empty-${++counter}`);
    mkdirSync(dir);
    const stub = stubBun();
    const r = run([SCRIPT, factory, stub.bin, "install"], dir);
    expect(r.code).toBe(7);
    expect(readFileSync(stub.out, "utf8")).toBe("install\n");
  });

  test("a bun killed by a signal exits 128 + signo, never 0", () => {
    const bin = join(root, `stub-killed-${++counter}.sh`);
    writeFileSync(bin, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o755 });
    const dir = join(root, `empty-${++counter}`);
    mkdirSync(dir);
    expect(run([SCRIPT, factory, bin, "install"], dir).code).toBe(128 + 15);
  });
});

describe("refusals change nothing on disk and never run the real install", () => {
  // A "real bun" that leaves a trace if it ever runs.
  let neverRun = "";
  beforeAll(() => {
    neverRun = join(root, "never-run.sh");
    writeFileSync(neverRun, "#!/bin/sh\nmkdir node_modules\nexit 0\n", { mode: 0o755 });
  });

  test("a dependency that is not a @crewhaus package", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3", "left-pad": "1.3.0" }));
    const r = run([SCRIPT, factory, neverRun, "install"], b.dir);
    expect(r.code).toBe(1);
    expect(lastLine(r.stderr)).toBe(
      "in-tree-bundle-install: left-pad is not a @crewhaus package; only those are linked in-tree",
    );
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
  });

  test("a @crewhaus name that would leave the scope directory", () => {
    const b = bundle(compiled({ "@crewhaus/../escape": "0.8.3" }));
    const r = run([SCRIPT, factory, neverRun, "install"], b.dir);
    expect(r.code).toBe(1);
    expect(lastLine(r.stderr)).toContain("@crewhaus/../escape is not a @crewhaus package");
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
  });

  test("a @crewhaus package the checkout does not have", () => {
    // A valid name sorts first, so a version that links as it validates fails here.
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3", "@crewhaus/zz-missing": "0.8.3" }));
    const r = run([SCRIPT, factory, neverRun, "install"], b.dir);
    expect(r.code).toBe(1);
    expect(lastLine(r.stderr)).toBe(
      `in-tree-bundle-install: @crewhaus/zz-missing is not in the factory checkout at ${factory}`,
    );
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
  });

  test("a @crewhaus package another one needs, which the checkout does not have", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3", "@crewhaus/c": "0.8.3" }));
    const r = run([SCRIPT, factory, neverRun, "install"], b.dir);
    expect(r.code).toBe(1);
    expect(lastLine(r.stderr)).toBe(
      `in-tree-bundle-install: @crewhaus/zz-gone (needed by @crewhaus/c) is not in the factory checkout at ${factory}`,
    );
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
  });

  test("a package the checkout has not built", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3", "@crewhaus/unbuilt": "0.8.3" }));
    const r = run([SCRIPT, factory, neverRun, "install"], b.dir);
    expect(r.code).toBe(1);
    expect(lastLine(r.stderr)).toBe(
      `in-tree-bundle-install: @crewhaus/unbuilt has no dist/ in ${factory}: run \`bun run build\` in the factory checkout first`,
    );
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
  });

  test("a checkout without its own install", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    const r = run([SCRIPT, bareFactory, neverRun, "install"], b.dir);
    expect(r.code).toBe(1);
    expect(lastLine(r.stderr)).toBe(
      `in-tree-bundle-install: ${bareFactory} has no node_modules: run \`bun install\` in the factory checkout first`,
    );
    expect(existsSync(join(b.dir, "node_modules"))).toBe(false);
  });
});

describe("verify-drivers picks in-tree installs only for the factory source CLI", () => {
  // One manifest, schema only: nothing compiles, and only the header and the
  // shims are under test. CREWHAUS_BIN is absent from the env and PATH holds
  // only bun's directory and the system's, so no installed crewhaus is found.
  const verify = (env: Record<string, string>) =>
    run([VERIFY, "--schema-only", "starters/managed/demo.beats.json"], REPO, env);
  const header = (stdout: string) => stdout.split("\n")[0] ?? "";

  test("with FACTORY_PATH: in-tree, and a bun shim that serves installs from it", () => {
    const r = verify({ FACTORY_PATH: factory });
    expect(r.code).toBe(0);
    expect(header(r.stdout)).toContain("CLI 0.0.0-fixture");
    expect(header(r.stdout)).toContain(`bundle deps: in-tree (${factory})`);
    // ../factory, when present, is another checkout than the fixture.
    expect(r.stdout.includes("this run mixes two checkouts")).toBe(
      existsSync(join(REPO, "..", "factory")),
    );

    const crewhausShim = readFileSync(join(SHIM_DIR, "crewhaus"), "utf8");
    expect(crewhausShim).toContain(
      `exec '${BUN}' '${join(factory, "apps", "cli", "src", "index.ts")}'`,
    );
    const bunShim = readFileSync(join(SHIM_DIR, "bun"), "utf8");
    expect(bunShim).toContain(`'${SCRIPT}' '${factory}' '${BUN}'`);

    // The shim itself: a bare install reaches the script (a manifest with no
    // dependencies keeps the real install offline); anything else is the real bun.
    const b = bundle(compiled({}));
    const shimEnv = { ...BASE_ENV, PATH: `${SHIM_DIR}:${BASE_ENV.PATH}` };
    const sh = (args: string[]) => {
      const r = Bun.spawnSync(["bun", ...args], {
        cwd: b.dir,
        env: shimEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: r.exitCode, stdout: r.stdout.toString() };
    };
    const install = sh(["install"]);
    expect(install.code).toBe(0);
    expect(lastLine(install.stdout)).toBe(
      `[in-tree] linked 0 @crewhaus package(s) from ${factory}`,
    );
    const other = sh(["-e", "console.log(process.execPath)"]);
    expect(other.code).toBe(0);
    expect(other.stdout.trim()).toBe(BUN);
  });

  test("with CREWHAUS_BIN: npm, and no bun shim", () => {
    // Leave an in-tree shim behind first, as an earlier run would.
    expect(verify({ FACTORY_PATH: factory }).code).toBe(0);
    expect(existsSync(join(SHIM_DIR, "bun"))).toBe(true);

    const cli = join(root, "published-crewhaus.sh");
    writeFileSync(cli, "#!/bin/sh\necho 9.9.9-published\n", { mode: 0o755 });
    const r = verify({ FACTORY_PATH: factory, CREWHAUS_BIN: cli });
    expect(r.code).toBe(0);
    expect(header(r.stdout)).toContain("CLI 9.9.9-published");
    expect(header(r.stdout)).toContain("bundle deps: npm");
    expect(r.stdout).not.toContain("mixes two checkouts");
    expect(readdirSync(SHIM_DIR).filter((f) => f === "bun")).toEqual([]);
  });
});
