#!/usr/bin/env bun
/**
 * Inventory of available demos.
 *
 * Walks the repo root, finds every top-level directory with a
 * `crewhaus.yaml`, and prints the demo name + its `target:` field +
 * whether a `README.md` is present. Drop-in replacement for the
 * discoverability that `bun run --list` provided when every demo had
 * its own `compile:hello-*` script.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

const EXCLUDED_DIRS = new Set([
  "node_modules",
  "scripts",
  "examples",
  ".github",
  ".crewhaus",
  ".git",
  ".claude",
]);

function targetOf(spec: string): string {
  try {
    const content = readFileSync(spec, "utf-8");
    const m = /^target:\s*(\S+)/m.exec(content);
    return m?.[1] ?? "(unknown)";
  } catch {
    return "(unreadable)";
  }
}

type Entry = { name: string; target: string; hasReadme: boolean };

function main(): void {
  const entries: Entry[] = [];
  for (const name of readdirSync(REPO_ROOT).sort()) {
    if (EXCLUDED_DIRS.has(name)) continue;
    if (name.startsWith(".")) continue;
    const dir = join(REPO_ROOT, name);
    const spec = join(dir, "crewhaus.yaml");
    if (!existsSync(spec)) continue;
    entries.push({
      name,
      target: targetOf(spec),
      hasReadme: existsSync(join(dir, "README.md")),
    });
  }

  if (entries.length === 0) {
    process.stdout.write("No demos found (no top-level dir contains crewhaus.yaml).\n");
    return;
  }

  const nameWidth = Math.max(...entries.map((e) => e.name.length));
  const targetWidth = Math.max(...entries.map((e) => e.target.length));
  process.stdout.write(
    `${"DEMO".padEnd(nameWidth)}  ${"TARGET".padEnd(targetWidth)}  README\n`,
  );
  process.stdout.write(`${"".padEnd(nameWidth, "-")}  ${"".padEnd(targetWidth, "-")}  ------\n`);
  for (const e of entries) {
    process.stdout.write(
      `${e.name.padEnd(nameWidth)}  ${e.target.padEnd(targetWidth)}  ${e.hasReadme ? "✓" : "✗"}\n`,
    );
  }
  process.stdout.write(`\n${entries.length} demos. Run \`bun run compile <demo>\` to build.\n`);
}

main();
