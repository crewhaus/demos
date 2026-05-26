#!/usr/bin/env bun
/**
 * Runtime smoke test for the hello-prochat showcase demo.
 *
 * Compile-smoke is handled by `bun run recipes:smoke` via the recipe's
 * frontmatter (recipes/50-prochat.md). This script adds a LIVE
 * runtime check: actually spawn the compiled bundle, send one prompt to
 * stdin, and assert the agent produces non-empty output within 60s.
 *
 * Run: `bun smoke/hello-prochat-smoke/smoke.ts`
 * Requires: `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` in env.
 *
 * Exits 0 on success, 1 on any failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEMO_DIR = join(REPO_ROOT, "hello-prochat");
const BUNDLE = join(DEMO_DIR, "dist", "agent.ts");
const FACTORY_ROOT = resolve(process.env["FACTORY_PATH"] ?? join(REPO_ROOT, "..", "factory"));
const CLI_ENTRY = join(FACTORY_ROOT, "apps/cli/src/index.ts");

function hasCreds(): boolean {
  return Boolean(process.env["ANTHROPIC_AUTH_TOKEN"] ?? process.env["ANTHROPIC_API_KEY"]);
}

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

console.log("section-hello-prochat-smoke starting…");

if (!hasCreds()) {
  console.log("  skip: no ANTHROPIC_* credential in env");
  process.exit(0);
}

if (!existsSync(BUNDLE)) {
  console.log("  compiling hello-prochat…");
  const compile = spawnSync("bun", [CLI_ENTRY, "compile", join(DEMO_DIR, "crewhaus.yaml"), "-o", join(DEMO_DIR, "dist")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (compile.status !== 0) die("compile failed");
}

console.log("  spawning agent + sending prompt…");
const child = spawn("bun", [BUNDLE], {
  cwd: DEMO_DIR,
  env: { ...process.env },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (d) => {
  stdout += String(d);
});
child.stderr.on("data", (d) => {
  stderr += String(d);
});

// Open-domain prompt the agent should answer from training data alone —
// no tool calls required, so the smoke doesn't hinge on web search
// credentials or sandbox availability.
child.stdin.write("What is 7 times 8? Reply with just the number.\n");

const result = await new Promise<{ ok: boolean; reason: string }>((resolveP) => {
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    resolveP({ ok: false, reason: "timed out waiting for response (60s)" });
  }, 60_000);

  const checkInterval = setInterval(() => {
    if (/\b56\b/.test(stdout)) {
      clearTimeout(timeout);
      clearInterval(checkInterval);
      child.kill("SIGTERM");
      resolveP({ ok: true, reason: "received expected answer (56)" });
    }
  }, 500);

  child.on("exit", () => {
    clearTimeout(timeout);
    clearInterval(checkInterval);
    if (!stdout.length) {
      resolveP({ ok: false, reason: "process exited with no stdout" });
      return;
    }
    resolveP({ ok: stdout.length > 0, reason: stdout.length > 0 ? "non-empty output" : "empty" });
  });
});

if (!result.ok) {
  console.error(`  stdout (first 500 bytes): ${stdout.slice(0, 500)}`);
  console.error(`  stderr (first 500 bytes): ${stderr.slice(0, 500)}`);
  die(`runtime smoke failed: ${result.reason}`);
}

console.log(`✓ section-hello-prochat-smoke: ${result.reason}`);
process.exit(0);
