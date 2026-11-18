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
  readdirSync,
  readFileSync,
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
  // A fixture checkout: two built packages (one with a subpath export), an
  // app, and its own (empty) install.
  factory = join(root, "factory");
  writeJson(join(factory, "packages", "a", "package.json"), {
    name: "@crewhaus/a",
    type: "module",
    exports: { ".": "./index.ts", "./sub": "./sub.ts" },
  });
  writeFileSync(join(factory, "packages", "a", "index.ts"), 'export const main = "a-main";\n');
  writeFileSync(join(factory, "packages", "a", "sub.ts"), 'export const sub = "a-sub-from-checkout";\n');
  writeJson(join(factory, "packages", "b", "package.json"), { name: "@crewhaus/b", type: "module" });
  mkdirSync(join(factory, "packages", "a", "dist"));
  mkdirSync(join(factory, "packages", "b", "dist"));
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
  const r = Bun.spawnSync([BUN, ...argv], { cwd, env: { ...BASE_ENV, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const lastLine = (s: string) => s.trim().split("\n").at(-1) ?? "";

/**
 * A stand-in for the real bun: records its argv, then exits `code`. With
 * `npm`, it first does what an npm install of `@crewhaus/a` would: a bun.lock
 * and a real `node_modules/@crewhaus/a` directory.
 */
function stubBun(code = 7, npm = false): { bin: string; out: string } {
  const bin = join(root, `stub-bun-${++counter}.sh`);
  const out = join(root, `stub-argv-${counter}.txt`);
  const fakeNpm = npm
    ? "printf 'lock\\n' > bun.lock\nmkdir -p node_modules/@crewhaus/a/dist\n" +
      "printf 'export const sub = \"npm\";\\n' > node_modules/@crewhaus/a/sub.ts\n"
    : "";
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${out}'\n${fakeNpm}exit ${code}\n`, { mode: 0o755 });
  return { bin, out };
}

describe("an in-tree install runs the real install, then links the checkout's packages", () => {
  test("every dependency becomes a link, after the real install, and the manifest is untouched", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3", "@crewhaus/b": "0.8.3" }));
    const stub = stubBun(0, true);
    const r = run([SCRIPT, factory, stub.bin, "install"], b.dir);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(lastLine(r.stdout)).toBe(`[in-tree] linked 2 @crewhaus package(s) from ${factory}`);
    // The real install ran once, with the same argv, and its bun.lock stays.
    expect(readFileSync(stub.out, "utf8")).toBe("install\n");
    expect(readFileSync(join(b.dir, "bun.lock"), "utf8")).toBe("lock\n");
    // Its npm copy of @crewhaus/a (a real directory) was replaced by the link.
    for (const name of ["a", "b"]) {
      const at = join(b.dir, "node_modules", "@crewhaus", name);
      expect(lstatSync(at).isSymbolicLink()).toBe(true);
      expect(realpathSync(at)).toBe(realpathSync(join(factory, "packages", name)));
    }
    expect(readFileSync(join(b.dir, "package.json"), "utf8")).toBe(b.text);
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

  test("a failed real install fails with its code, and links nothing", () => {
    const b = bundle(compiled({ "@crewhaus/a": "0.8.3" }));
    const r = run([SCRIPT, factory, stubBun(5, true).bin, "install"], b.dir);
    expect(r.code).toBe(5);
    expect(r.stdout).not.toContain("[in-tree]");
    expect(lstatSync(join(b.dir, "node_modules", "@crewhaus", "a")).isSymbolicLink()).toBe(false);
  });
});

describe("anything else runs the real bun unchanged", () => {
  const cases: [string, unknown, string[]][] = [
    ["a manifest with another name (a cf-worker bundle)", { name: "my-worker", dependencies: {} }, ["install"]],
    ["install with more arguments", compiled({ "@crewhaus/a": "0.8.3" }), ["install", "--frozen-lockfile"]],
    ["another command", compiled({ "@crewhaus/a": "0.8.3" }), ["--env-file=/dev/null", "daemon.ts"]],
    ["a manifest that is not JSON", "{not json", ["install"]],
  ];
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
    expect(r.stdout.includes("this run mixes two checkouts")).toBe(existsSync(join(REPO, "..", "factory")));

    const crewhausShim = readFileSync(join(SHIM_DIR, "crewhaus"), "utf8");
    expect(crewhausShim).toContain(`exec '${BUN}' '${join(factory, "apps", "cli", "src", "index.ts")}'`);
    const bunShim = readFileSync(join(SHIM_DIR, "bun"), "utf8");
    expect(bunShim).toContain(`'${SCRIPT}' '${factory}' '${BUN}'`);

    // The shim itself: a bare install reaches the script (a manifest with no
    // dependencies keeps the real install offline); anything else is the real bun.
    const b = bundle(compiled({}));
    const shimEnv = { ...BASE_ENV, PATH: `${SHIM_DIR}:${BASE_ENV.PATH}` };
    const sh = (args: string[]) => {
      const r = Bun.spawnSync(["bun", ...args], { cwd: b.dir, env: shimEnv, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode, stdout: r.stdout.toString() };
    };
    const install = sh(["install"]);
    expect(install.code).toBe(0);
    expect(lastLine(install.stdout)).toBe(`[in-tree] linked 0 @crewhaus package(s) from ${factory}`);
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
