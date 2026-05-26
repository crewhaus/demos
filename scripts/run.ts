#!/usr/bin/env bun
/**
 * Parameterized run: `bun run run <demo>`.
 *
 * Picks the right entry file from the compiled `dist/` based on what
 * the codegen emitted: daemon-shaped targets (channel, voice, crew,
 * managed, multichat) produce `daemon.ts`; everything else produces
 * `agent.ts`. We prefer daemon when present — the simplest heuristic
 * that matches the convention every previous per-demo `run:hello-*`
 * encoded by hand.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

function main(): void {
  const demo = process.argv[2];
  if (!demo) {
    process.stderr.write(
      "Usage: bun run run <demo>\n" +
        "  e.g. bun run run hello-cli\n" +
        "Run `bun run list` to see available demos.\n",
    );
    process.exit(1);
  }

  const distDir = join(resolve(REPO_ROOT, demo), "dist");
  if (!existsSync(distDir)) {
    process.stderr.write(
      `No dist/ at ${distDir}.\n` + `Run \`bun run compile ${demo}\` first.\n`,
    );
    process.exit(1);
  }

  const entry = ["daemon.ts", "agent.ts"]
    .map((f) => join(distDir, f))
    .find((p) => existsSync(p));

  if (!entry) {
    process.stderr.write(
      `No daemon.ts or agent.ts in ${distDir}.\n` +
        `(Re-run \`bun run compile ${demo}\` — the codegen may have failed silently.)\n`,
    );
    process.exit(1);
  }

  const passthrough = process.argv.slice(3);
  const result = spawnSync("bun", [entry, ...passthrough], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

main();
