#!/usr/bin/env bun
/**
 * Inventory of available demos.
 *
 * Walks `starters/` (top tier + channels/{...} + showcases/{...}), finds
 * every directory with a `crewhaus.yaml`, and prints the demo name + its
 * `target:` field + whether a `README.md` is present. Drop-in replacement
 * for the discoverability that `bun run --list` provided when every demo
 * had its own `compile:hello-*` script.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const STARTERS_ROOT = join(REPO_ROOT, "starters");

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

function walk(dir: string, entries: Entry[]): void {
  const spec = join(dir, "crewhaus.yaml");
  if (existsSync(spec)) {
    entries.push({
      name: relative(REPO_ROOT, dir),
      target: targetOf(spec),
      hasReadme: existsSync(join(dir, "README.md")),
    });
    return; // don't descend into a demo dir
  }
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    if (name === "node_modules" || name === "dist") continue;
    const child = join(dir, name);
    if (statSync(child).isDirectory()) walk(child, entries);
  }
}

function main(): void {
  if (!existsSync(STARTERS_ROOT)) {
    process.stdout.write("No starters/ directory found.\n");
    return;
  }

  const entries: Entry[] = [];
  walk(STARTERS_ROOT, entries);

  if (entries.length === 0) {
    process.stdout.write("No demos found under starters/.\n");
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
