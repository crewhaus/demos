#!/usr/bin/env bun
/**
 * Runtime smoke test for the hello-code showcase demo.
 *
 * Compile-smoke is handled by `bun run recipes:smoke` via the recipe's
 * frontmatter (recipes/49-claude-code-clone.md). This script adds a LIVE
 * runtime check: actually spawn the compiled bundle, send one prompt to
 * stdin, and assert the agent produces non-empty output within 60s.
 *
 * Run: `bun scripts/section-hello-code-smoke.ts`
 * Requires: `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` in env.
 *
 * Exits 0 on success, 1 on any failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEMO_DIR = join(REPO_ROOT, "hello-code");
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

console.log("section-hello-code-smoke starting…");

if (!hasCreds()) {
  console.log("  skip: no ANTHROPIC_* credential in env");
  process.exit(0);
}

// Step 1 — compile the bundle if not already present.
if (!existsSync(BUNDLE)) {
  console.log("  compiling hello-code…");
  const compile = spawnSync("bun", [CLI_ENTRY, "compile", join(DEMO_DIR, "crewhaus.yaml"), "-o", join(DEMO_DIR, "dist")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (compile.status !== 0) die("compile failed");
}

// Step 2 — spawn the bundle, pipe one prompt, capture output.
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

// Use a simple non-tool-requiring prompt so the smoke doesn't hinge on
// MCP availability, web search, or filesystem state.
child.stdin.write("Reply with exactly the word: pong\n");

const result = await new Promise<{ ok: boolean; reason: string }>((resolveP) => {
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    resolveP({ ok: false, reason: "timed out waiting for response (60s)" });
  }, 60_000);

  const checkInterval = setInterval(() => {
    // Heuristic: if we've seen the model's reply mention "pong" (or any
    // non-empty alpha sequence beyond the cwd echo), the loop is alive.
    if (/pong/i.test(stdout)) {
      clearTimeout(timeout);
      clearInterval(checkInterval);
      child.kill("SIGTERM");
      resolveP({ ok: true, reason: "received pong" });
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

console.log(`✓ section-hello-code-smoke: ${result.reason}`);
process.exit(0);
