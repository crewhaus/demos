#!/usr/bin/env bun
/**
 * in-tree-bundle-install — the `bun install` a compiled bundle gets when
 * verify-drivers runs the factory source CLI.
 *
 * A compiled bundle's package.json pins every `@crewhaus/*` package it imports
 * to the CLI's own version, so a plain `bun install` fetches the newest npm
 * release. When the CLI is a factory checkout ahead of that release, the
 * bundle then boots against packages it was not compiled with, or fails to
 * install at all when a package is not released yet. verify-drivers puts a
 * `bun` shim first on every beat's PATH in that mode; the shim sends a bare
 * `bun install` here, and this script serves every `@crewhaus` package from
 * the checkout instead, so a driver tests the code it compiled with.
 *
 *   bun scripts/in-tree-bundle-install.ts <factoryRoot> <realBun> [args…]
 *
 * Acting from the current directory:
 *   - args exactly `install` and ./package.json named `crewhaus-compiled-bundle`
 *     → follow the bundle's dependencies through the checkout (every
 *       `@crewhaus` or `workspace:` edge of every package reached, the way an
 *       npm install would), check every package reached, then run the real
 *       `bun install` in a scratch directory on a manifest that lists only the
 *       third-party packages of that closure. No `@crewhaus` package is ever
 *       fetched. Its `node_modules` and `bun.lock` replace the bundle's, and
 *       `node_modules/@crewhaus/<name>` becomes a link to the checkout's
 *       package dir for every package of the closure, and for any other entry
 *       there whose name the checkout has. One summary line, exit 0. The
 *       bundle's manifest is never written: the compile's stamp and pins stay
 *       what factory wrote.
 *   - anything else (another directory, a cf-worker bundle's own manifest,
 *     other args) → run `<realBun> args…` unchanged and exit with its code.
 *
 * The checkout must be installed and built (`bun install`, then
 * `bun run build`): a published package is its `dist/` build, and some beats
 * read `node_modules/@crewhaus/<name>/dist/…` directly. Every package of the
 * closure is checked before anything on disk changes. A refusal exits 1 with
 * one short line on stderr, because `crewhaus compile --check` reports only
 * the last two stderr lines of a failed install.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";

/** The `name` factory stamps into the manifest it synthesizes for a bundle. */
export const BUNDLE_MANIFEST_NAME = "crewhaus-compiled-bundle";

/** The `name` of the scratch manifest the real install resolves. */
export const DEPS_MANIFEST_NAME = "crewhaus-compiled-bundle-deps";

/** A `@crewhaus/<pkg>` name with a single, traversal-free segment. */
const CREWHAUS_NAME = /^@crewhaus\/[a-z0-9][a-z0-9._-]*$/;

/** True when `manifestText` is a compiled bundle's own manifest. */
export function isCompiledBundleManifest(manifestText: string | undefined): boolean {
  if (manifestText === undefined) return false;
  try {
    const parsed: unknown = JSON.parse(manifestText);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { name?: unknown }).name === BUNDLE_MANIFEST_NAME
    );
  } catch {
    return false;
  }
}

/** True when this invocation is the install to serve in-tree. */
export function isInTreeInstall(
  args: readonly string[],
  manifestText: string | undefined,
): boolean {
  return args.length === 1 && args[0] === "install" && isCompiledBundleManifest(manifestText);
}

/** What the closure walk needs from one checkout package. */
export interface FactoryPackage {
  dir: string;
  /** Edges an install follows: dependencies, optionalDependencies and required peers. */
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

/**
 * Map every package name in the checkout to its directory and install edges,
 * from `packages/*\/package.json` and `apps/*\/package.json`. The root
 * `node_modules/@crewhaus` is deliberately not consulted: factory uses Bun's
 * isolated linker, so that directory is not a package index and a long-lived
 * checkout can hold stale entries there. A peer marked optional is not an
 * edge, as no install adds one.
 */
export function indexFactoryPackages(factoryRoot: string): Map<string, FactoryPackage> {
  const index = new Map<string, FactoryPackage>();
  for (const group of ["packages", "apps"]) {
    const base = join(factoryRoot, group);
    let entries: string[];
    try {
      entries = readdirSync(base).sort();
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(base, entry);
      let manifest: Record<string, unknown>;
      try {
        manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const name = manifest.name;
      if (typeof name !== "string" || index.has(name)) continue;
      const peerMeta = (manifest.peerDependenciesMeta ?? {}) as Record<
        string,
        { optional?: unknown }
      >;
      const requiredPeers = Object.fromEntries(
        Object.entries(stringRecord(manifest.peerDependencies)).filter(
          ([peer]) => peerMeta[peer]?.optional !== true,
        ),
      );
      index.set(name, {
        dir,
        dependencies: { ...requiredPeers, ...stringRecord(manifest.dependencies) },
        optionalDependencies: stringRecord(manifest.optionalDependencies),
      });
    }
  }
  return index;
}

export interface InstallPlan {
  /** Every `@crewhaus` package of the closure, sorted by name. */
  links: { name: string; target: string }[];
  /** The scratch manifest: third-party packages only. */
  depsManifest: {
    name: string;
    private: true;
    dependencies: Record<string, string>;
    optionalDependencies: Record<string, string>;
  };
}

export type LinkPlan = ({ ok: true } & InstallPlan) | { ok: false; error: string };

/** Refuses a package the checkout does not have or has not built. */
function checkPackage(
  name: string,
  factoryRoot: string,
  index: Map<string, FactoryPackage>,
  neededBy?: string,
): { ok: true; pkg: FactoryPackage } | { ok: false; error: string } {
  const via = neededBy === undefined ? "" : ` (needed by ${neededBy})`;
  if (!CREWHAUS_NAME.test(name)) {
    return {
      ok: false,
      error: `${name}${via} is not a @crewhaus package; only those are linked in-tree`,
    };
  }
  const pkg = index.get(name);
  if (pkg === undefined) {
    return { ok: false, error: `${name}${via} is not in the factory checkout at ${factoryRoot}` };
  }
  if (!existsSync(join(pkg.dir, "dist"))) {
    return {
      ok: false,
      error: `${name} has no dist/ in ${factoryRoot}: run \`bun run build\` in the factory checkout first`,
    };
  }
  return { ok: true, pkg };
}

/**
 * Decide the whole install before touching the disk: walk the bundle's
 * dependencies through the checkout, following every edge whose name is
 * `@crewhaus/*` or whose spec is `workspace:`, and collect the third-party
 * packages the closure needs (the first spec reached wins; each linked
 * package still resolves its own dependencies from the checkout's install).
 * Refuses a bundle dependency that is not `@crewhaus/*`, a `@crewhaus` name
 * the checkout does not have, a package the checkout has not built (no
 * `dist/`), and a checkout without its own `bun install`.
 */
export function planLinks(
  manifestText: string,
  factoryRoot: string,
  index: Map<string, FactoryPackage>,
  hasInstall: boolean,
): LinkPlan {
  const manifest = JSON.parse(manifestText) as { dependencies?: unknown };
  const deps = manifest.dependencies ?? {};
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    return { ok: false, error: "the bundle's package.json has no dependencies object" };
  }
  const reached = new Map<string, string>();
  const queue: string[] = [];
  for (const name of Object.keys(deps).sort()) {
    const checked = checkPackage(name, factoryRoot, index);
    if (!checked.ok) return checked;
    reached.set(name, checked.pkg.dir);
    queue.push(name);
  }
  // Maps, not objects: a package may be named `constructor`.
  const dependencies = new Map<string, string>();
  const optionalDependencies = new Map<string, string>();
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i] as string;
    const pkg = index.get(from) as FactoryPackage;
    const edges: [string, string, boolean][] = [
      ...Object.entries(pkg.dependencies).map(([n, s]): [string, string, boolean] => [n, s, false]),
      ...Object.entries(pkg.optionalDependencies).map(([n, s]): [string, string, boolean] => [
        n,
        s,
        true,
      ]),
    ].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    for (const [name, spec, optional] of edges) {
      if (name.startsWith("@crewhaus/") || spec.startsWith("workspace:")) {
        if (reached.has(name)) continue;
        const checked = checkPackage(name, factoryRoot, index, from);
        if (!checked.ok) return checked;
        reached.set(name, checked.pkg.dir);
        queue.push(name);
      } else if (optional) {
        if (!optionalDependencies.has(name)) optionalDependencies.set(name, spec);
      } else if (!dependencies.has(name)) {
        dependencies.set(name, spec);
      }
    }
  }
  if (!hasInstall) {
    return {
      ok: false,
      error: `${factoryRoot} has no node_modules: run \`bun install\` in the factory checkout first`,
    };
  }
  // A package some edge requires is never only optional.
  const sortKeys = (r: Map<string, string>, except = new Map<string, string>()) =>
    Object.fromEntries(
      [...r].filter(([n]) => !except.has(n)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return {
    ok: true,
    links: [...reached]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, target]) => ({ name, target })),
    depsManifest: {
      name: DEPS_MANIFEST_NAME,
      private: true,
      dependencies: sortKeys(dependencies),
      optionalDependencies: sortKeys(optionalDependencies, dependencies),
    },
  };
}

/** Replace `node_modules/@crewhaus/<name>` with a link to each target. */
export function applyLinks(
  bundleDir: string,
  links: readonly { name: string; target: string }[],
): void {
  const scopeDir = join(bundleDir, "node_modules", "@crewhaus");
  mkdirSync(scopeDir, { recursive: true });
  for (const { name, target } of links) {
    const at = join(scopeDir, name.slice("@crewhaus/".length));
    let present = false;
    try {
      lstatSync(at);
      present = true;
    } catch {
      present = false;
    }
    // A link from an earlier run, or a real directory a third-party package pulled in.
    if (present) rmSync(at, { recursive: true, force: true });
    symlinkSync(target, at, "dir");
  }
}

/**
 * Every real directory under `node_modules/@crewhaus/` that is not already a
 * link: a third-party package can still pull one in from npm. Those the
 * checkout has (and has built) are returned as links to make; the rest are
 * named, so the summary can say which packages still came from npm.
 */
export function strayEntries(
  bundleDir: string,
  factoryRoot: string,
  index: Map<string, FactoryPackage>,
):
  | { ok: true; links: { name: string; target: string }[]; npm: string[] }
  | { ok: false; error: string } {
  const scopeDir = join(bundleDir, "node_modules", "@crewhaus");
  let entries: string[];
  try {
    entries = readdirSync(scopeDir).sort();
  } catch {
    return { ok: true, links: [], npm: [] };
  }
  const links: { name: string; target: string }[] = [];
  const npm: string[] = [];
  for (const entry of entries) {
    if (lstatSync(join(scopeDir, entry)).isSymbolicLink()) continue;
    const name = `@crewhaus/${entry}`;
    if (!index.has(name)) {
      npm.push(name);
      continue;
    }
    const checked = checkPackage(name, factoryRoot, index);
    if (!checked.ok) return checked;
    links.push({ name, target: checked.pkg.dir });
  }
  return { ok: true, links, npm };
}

/** Run the real bun unchanged; a signal death maps to 128 + signo, never 0. */
export function passThrough(realBun: string, args: readonly string[], cwd: string): number {
  const r = spawnSync(realBun, [...args], { cwd, env: process.env, stdio: "inherit" });
  if (r.error) {
    console.error(`in-tree-bundle-install: could not run ${realBun}: ${r.error.message}`);
    return 127;
  }
  if (r.signal) return 128 + ((constants.signals as Record<string, number>)[r.signal] ?? 0);
  return r.status ?? 1;
}

/**
 * Run the real install on the scratch manifest, then move its
 * `node_modules` and `bun.lock` into the bundle. The scratch directory sits
 * inside the bundle, so the install sees the same config and the moves
 * never cross a filesystem. Returns the install's exit code; on failure the
 * bundle is untouched.
 */
export function installThirdParty(
  realBun: string,
  bundleDir: string,
  depsManifest: InstallPlan["depsManifest"],
): number {
  const scratch = mkdtempSync(join(bundleDir, ".in-tree-install-"));
  try {
    writeFileSync(join(scratch, "package.json"), `${JSON.stringify(depsManifest, null, 2)}\n`);
    const code = passThrough(realBun, ["install"], scratch);
    if (code !== 0) return code;
    const modules = join(bundleDir, "node_modules");
    rmSync(modules, { recursive: true, force: true });
    if (existsSync(join(scratch, "node_modules")))
      renameSync(join(scratch, "node_modules"), modules);
    else mkdirSync(modules);
    // bun deletes the lockfile of a manifest with nothing to install.
    const lock = join(bundleDir, "bun.lock");
    if (existsSync(join(scratch, "bun.lock"))) renameSync(join(scratch, "bun.lock"), lock);
    else rmSync(lock, { force: true });
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The whole command; returns the exit code. */
export function main(argv: readonly string[], cwd: string): number {
  const [factoryArg, realBun, ...args] = argv;
  if (factoryArg === undefined || realBun === undefined) {
    console.error("usage: bun scripts/in-tree-bundle-install.ts <factoryRoot> <realBun> [args…]");
    return 2;
  }
  let manifestText: string | undefined;
  try {
    manifestText = readFileSync(join(cwd, "package.json"), "utf8");
  } catch {
    manifestText = undefined;
  }
  if (manifestText === undefined || !isInTreeInstall(args, manifestText)) {
    return passThrough(realBun, args, cwd);
  }
  const factoryRoot = resolve(factoryArg);
  const index = indexFactoryPackages(factoryRoot);
  const plan = planLinks(
    manifestText,
    factoryRoot,
    index,
    existsSync(join(factoryRoot, "node_modules")),
  );
  if (!plan.ok) {
    console.error(`in-tree-bundle-install: ${plan.error}`);
    return 1;
  }
  // The third-party tree and bun.lock a viewer gets, then the links.
  const installed = installThirdParty(realBun, cwd, plan.depsManifest);
  if (installed !== 0) return installed;
  applyLinks(cwd, plan.links);
  const stray = strayEntries(cwd, factoryRoot, index);
  if (!stray.ok) {
    console.error(`in-tree-bundle-install: ${stray.error}`);
    return 1;
  }
  applyLinks(cwd, stray.links);
  if (stray.npm.length > 0) {
    console.log(`[in-tree] not in the checkout, so from npm: ${stray.npm.join(", ")}`);
  }
  const linked = plan.links.length + stray.links.length;
  console.log(`[in-tree] linked ${linked} @crewhaus package(s) from ${factoryRoot}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2), process.cwd()));
