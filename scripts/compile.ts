#!/usr/bin/env bun
/**
 * Parameterized compile: `bun run compile <demo>`.
 *
 * Shells out to the factory CLI to compile `<demo>/crewhaus.yaml` →
 * `<demo>/dist/`. Replaces the per-demo `compile:hello-*` aliases the
 * package.json used to grow one-per-demo. Adding a new demo no longer
 * requires editing package.json — drop a directory with a crewhaus.yaml
 * and `bun run compile <name>` works.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Resolve the CLI invocation. Precedence:
 *   1. FACTORY_PATH env or ../factory sibling → contributor mode (use the source CLI)
 *   2. node_modules/@crewhaus/cli → npm-installed (default after `bun install`)
 *   3. fall back to `bun x crewhaus` so a global install also works.
 */
function resolveCli(): string[] {
  const factoryEnv = process.env["FACTORY_PATH"];
  const factoryRoot = factoryEnv ?? join(REPO_ROOT, "..", "factory");
  const localCli = join(factoryRoot, "apps", "cli", "src", "index.ts");
  if (existsSync(localCli)) return ["bun", localCli];
  const installedCli = join(REPO_ROOT, "node_modules", "@crewhaus", "cli", "src", "index.ts");
  if (existsSync(installedCli)) return ["bun", installedCli];
  return ["bun", "x", "crewhaus"];
}

function main(): void {
  const demo = process.argv[2];
  if (!demo) {
    process.stderr.write(
      "Usage: bun run compile <demo>\n" +
        "  e.g. bun run compile hello-cli\n" +
        "  e.g. bun run compile hello-channel-discord\n" +
        "Run `bun run list` to see available demos.\n",
    );
    process.exit(1);
  }

  const demoDir = resolve(REPO_ROOT, demo);
  const spec = join(demoDir, "crewhaus.yaml");
  if (!existsSync(spec)) {
    process.stderr.write(`No crewhaus.yaml at ${spec}\n`);
    process.exit(1);
  }
  const out = join(demoDir, "dist");

  const cli = resolveCli();
  const result = spawnSync(cli[0]!, [...cli.slice(1), "compile", spec, "-o", out], {
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

main();
