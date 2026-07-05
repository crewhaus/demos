#!/usr/bin/env bun
/**
 * Runtime smoke test for the hello-procode showcase demo.
 *
 * Compile-smoke is handled by `bun run recipes:smoke` via the recipe's
 * frontmatter (walkthroughs/49-procode.md). This script adds a LIVE
 * runtime check: actually spawn the compiled bundle, send one prompt to
 * stdin, and assert the agent echoes the expected reply ("pong") within
 * 60s. Non-empty stdout alone is NOT a pass — a banner plus an auth
 * error must fail.
 *
 * Run: `bun smoke/hello-procode-smoke/smoke.ts`
 * Requires: `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY` in env.
 *
 * Exits 0 on success, 1 on any failure.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEMO_DIR = join(REPO_ROOT, "starters/showcases/procode");
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

console.log("section-hello-procode-smoke starting…");

if (!hasCreds()) {
  console.log("  skip: no ANTHROPIC_* credential in env");
  process.exit(0);
}

// Step 1 — compile the bundle if not already present.
if (!existsSync(BUNDLE)) {
  console.log("  compiling hello-procode…");
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
const PROMPT = "Reply with exactly the word: pong";
child.stdin.write(`${PROMPT}\n`);

// The ONLY pass condition: the model's reply contains "pong". Strip any
// echo of our own prompt line first so it can't satisfy the check.
const sawPong = (): boolean => /pong/i.test(stdout.split(PROMPT).join(""));

const result = await new Promise<{ ok: boolean; reason: string }>((resolveP) => {
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    resolveP({ ok: false, reason: "timed out waiting for response (60s)" });
  }, 60_000);

  const checkInterval = setInterval(() => {
    if (sawPong()) {
      clearTimeout(timeout);
      clearInterval(checkInterval);
      child.kill("SIGTERM");
      resolveP({ ok: true, reason: "received pong" });
    }
  }, 500);

  child.on("exit", (code) => {
    clearTimeout(timeout);
    clearInterval(checkInterval);
    // Re-check on exit: a fast clean run can finish between interval
    // ticks. Anything else — banner-only stdout, auth errors, crashes —
    // is a FAIL even if stdout is non-empty.
    if (sawPong()) {
      resolveP({ ok: true, reason: "received pong" });
      return;
    }
    resolveP({ ok: false, reason: `process exited (code ${code}) without replying "pong"` });
  });
});

if (!result.ok) {
  console.error(`  stdout (first 500 bytes): ${stdout.slice(0, 500)}`);
  console.error(`  stderr (first 500 bytes): ${stderr.slice(0, 500)}`);
  die(`runtime smoke failed: ${result.reason}`);
}

console.log(`✓ section-hello-procode-smoke: ${result.reason}`);
process.exit(0);
