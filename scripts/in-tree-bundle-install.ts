#!/usr/bin/env bun
/**
 * in-tree-bundle-install — the `bun install` a compiled bundle gets when
 * verify-drivers runs the factory source CLI.
 *
 * A compiled bundle's package.json pins every `@crewhaus/*` package it imports
 * to the CLI's own version, so a plain `bun install` fetches the newest npm
 * release. When the CLI is a factory checkout ahead of that release, the
 * bundle then boots against packages it was not compiled with. verify-drivers
 * puts a `bun` shim first on every beat's PATH in that mode; the shim sends a
 * bare `bun install` here, and this script links each `@crewhaus/*`
 * dependency of a compiled bundle to its package in the checkout instead, so
 * a driver tests the code it compiled with.
 *
 *   bun scripts/in-tree-bundle-install.ts <factoryRoot> <realBun> [args…]
 *
 * Acting from the current directory:
 *   - args exactly `install` and ./package.json named `crewhaus-compiled-bundle`
 *     → check every dependency, run the real `bun install` as before (it writes
 *       bun.lock and the third-party tree), then replace
 *       `node_modules/@crewhaus/<name>` with a link to the checkout's package
 *       dir for every dependency, print one summary line, exit 0. The manifest
 *       is never written: the compile's stamp and pins stay what factory wrote.
 *   - anything else (another directory, a cf-worker bundle's own manifest,
 *     other args) → run `<realBun> args…` unchanged and exit with its code.
 *
 * The checkout must be installed and built (`bun install`, then
 * `bun run build`): a published package is its `dist/` build, and some beats
 * read `node_modules/@crewhaus/<name>/dist/…` directly. Every dependency is
 * checked before anything on disk changes. A refusal exits 1 with one short
 * line on stderr, because `crewhaus compile --check` reports only the last two
 * stderr lines of a failed install.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { constants } from "node:os";
import { join, resolve } from "node:path";

/** The `name` factory stamps into the manifest it synthesizes for a bundle. */
export const BUNDLE_MANIFEST_NAME = "crewhaus-compiled-bundle";

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
export function isInTreeInstall(args: readonly string[], manifestText: string | undefined): boolean {
  return args.length === 1 && args[0] === "install" && isCompiledBundleManifest(manifestText);
}

/**
 * Map every package name in the checkout to its directory, from
 * `packages/*\/package.json` and `apps/*\/package.json`. The root
 * `node_modules/@crewhaus` is deliberately not consulted: factory uses Bun's
 * isolated linker, so that directory is not a package index and a long-lived
 * checkout can hold stale entries there.
 */
export function indexFactoryPackages(factoryRoot: string): Map<string, string> {
  const index = new Map<string, string>();
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
      let name: unknown;
      try {
        name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown })
          .name;
      } catch {
        continue;
      }
      if (typeof name === "string" && !index.has(name)) index.set(name, dir);
    }
  }
  return index;
}

export type LinkPlan =
  | { ok: true; links: { name: string; target: string }[] }
  | { ok: false; error: string };

/**
 * Decide every link before touching the disk. Refuses a dependency that is
 * not `@crewhaus/*`, a `@crewhaus` name the checkout does not have, a package
 * the checkout has not built (no `dist/`), and a checkout without its own
 * `bun install` (the linked packages resolve their own dependencies from it).
 */
export function planLinks(
  manifestText: string,
  factoryRoot: string,
  index: Map<string, string>,
  hasInstall: boolean,
): LinkPlan {
  const manifest = JSON.parse(manifestText) as { dependencies?: unknown };
  const deps = manifest.dependencies ?? {};
  if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
    return { ok: false, error: "the bundle's package.json has no dependencies object" };
  }
  const links: { name: string; target: string }[] = [];
  for (const name of Object.keys(deps).sort()) {
    if (!CREWHAUS_NAME.test(name)) {
      return { ok: false, error: `${name} is not a @crewhaus package; only those are linked in-tree` };
    }
    const target = index.get(name);
    if (target === undefined) {
      return { ok: false, error: `${name} is not in the factory checkout at ${factoryRoot}` };
    }
    if (!existsSync(join(target, "dist"))) {
      return {
        ok: false,
        error: `${name} has no dist/ in ${factoryRoot}: run \`bun run build\` in the factory checkout first`,
      };
    }
    links.push({ name, target });
  }
  if (!hasInstall) {
    return {
      ok: false,
      error: `${factoryRoot} has no node_modules: run \`bun install\` in the factory checkout first`,
    };
  }
  return { ok: true, links };
}

/** Replace `node_modules/@crewhaus/<name>` with a link to each target. */
export function applyLinks(bundleDir: string, links: readonly { name: string; target: string }[]): void {
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
    // A link from an earlier run, or a real directory from an npm install.
    if (present) rmSync(at, { recursive: true, force: true });
    symlinkSync(target, at, "dir");
  }
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
  const plan = planLinks(
    manifestText,
    factoryRoot,
    indexFactoryPackages(factoryRoot),
    existsSync(join(factoryRoot, "node_modules")),
  );
  if (!plan.ok) {
    console.error(`in-tree-bundle-install: ${plan.error}`);
    return 1;
  }
  // The install a viewer gets (bun.lock, third-party packages), then the links.
  const installed = passThrough(realBun, args, cwd);
  if (installed !== 0) return installed;
  applyLinks(cwd, plan.links);
  console.log(`[in-tree] linked ${plan.links.length} @crewhaus package(s) from ${factoryRoot}`);
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2), process.cwd()));
