#!/usr/bin/env bun
/**
 * Dynamic recipe smoke test.
 *
 * Where scripts/test-walkthroughs.ts does static validation (links, spec
 * parsing, package.json script presence), this script actually runs
 * each recipe's compile and (in live mode) run cycle.
 *
 * Two modes:
 *
 *   - Default (RECIPE_SMOKE_LIVE unset): runs only `compile:*` scripts.
 *     No model calls, no credentials, no cost. Catches bugs where a
 *     spec parses but the codegen + bundler steps fail.
 *
 *   - Live (RECIPE_SMOKE_LIVE=1): also runs `run`, `smoke:*`, and any
 *     other `bun_scripts` entries the recipe declares. Requires an
 *     Anthropic credential in env.
 *
 * Recipes opt in two ways:
 *
 *   1. `spec:` — the recipe's demo path. The runner derives the demo
 *      name from the spec (`hello-cli/crewhaus.yaml` → `hello-cli`) and
 *      runs `bun run compile <demo>` (safe) + `bun run run <demo>`
 *      (live). Replaces the per-demo `compile:hello-*` aliases removed
 *      in PR 2.
 *   2. `bun_scripts:` — extra script invocations the recipe depends on
 *      (e.g. `smoke:section-12`). Still routed through the classifier
 *      below.
 *
 *   ---
 *   test:
 *     spec: hello-cli/crewhaus.yaml
 *     bun_scripts:
 *       - smoke:section-12     # extra smoke beyond compile/run
 *   ---
 *
 * Exit codes: 0 if every selected script succeeded; 1 otherwise.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WALKTHROUGHS_DIR = join(REPO_ROOT, "walkthroughs");
const PACKAGE_JSON = join(REPO_ROOT, "package.json");
const FACTORY_ROOT = resolve(process.env["FACTORY_PATH"] ?? join(REPO_ROOT, "..", "factory"));
const LIVE = process.env["RECIPE_SMOKE_LIVE"] === "1";

// Scripts present in either repo's package.json. The smoke runner skips
// recipes referencing scripts that aren't actually defined — those are
// aspirational gaps (caught with an inline-documented allowlist by the
// static gate `walkthroughs:test`) and the live invocation here would just
// fail with "Script not found" if we didn't filter first.
let definedScriptsCache: Set<string> | undefined;
function loadDefinedScripts(): Set<string> {
  if (definedScriptsCache) return definedScriptsCache;
  const set = new Set<string>();
  for (const pkgPath of [PACKAGE_JSON, join(FACTORY_ROOT, "package.json")]) {
    if (!existsSync(pkgPath)) continue;
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    for (const name of Object.keys(parsed.scripts ?? {})) set.add(name);
  }
  definedScriptsCache = set;
  return set;
}

const SAFE_PREFIXES = ["compile:"];
const LIVE_PREFIXES = ["run:", "smoke:"];

// Scripts that require non-Anthropic credentials beyond `RECIPE_SMOKE_LIVE`.
// The smoke runner skips them (instead of failing loudly) when the listed
// env vars are absent — e.g. `run:hello-channel` boots a Slack daemon and
// fails immediately without `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`. Adding
// an entry here is purely cosmetic: the underlying script still fails-loud
// when invoked directly, which is the right behavior outside CI.
const REQUIRES_ENV: Record<string, readonly string[]> = {
  "run:hello-channel": ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
};

type Frontmatter = { spec?: string; bunScripts?: string[] };

type Result = {
  recipe: string;
  script: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
};

const results: Result[] = [];

function parseFrontmatter(content: string): Frontmatter {
  if (!content.startsWith("---\n")) return {};
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return {};
  const lines = content.slice(4, end).split("\n");
  const out: Frontmatter = {};
  let inTest = false;
  let inList: "bunScripts" | undefined;
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\r$/, "");
    if (/^test:\s*$/.test(line)) {
      inTest = true;
      continue;
    }
    if (!inTest) continue;
    const specM = /^\s{2}spec:\s*(.+?)\s*$/.exec(line);
    if (specM?.[1] !== undefined) {
      out.spec = stripQuotes(specM[1]);
      inList = undefined;
      continue;
    }
    if (/^\s{2}bun_scripts:\s*$/.test(line)) {
      inList = "bunScripts";
      out.bunScripts = [];
      continue;
    }
    const itemM = /^\s{4}-\s*(.+?)\s*$/.exec(line);
    if (itemM?.[1] !== undefined && inList === "bunScripts") {
      const list = out.bunScripts;
      if (list !== undefined) list.push(stripQuotes(itemM[1]));
      continue;
    }
    if (/^\s{2}\w/.test(line)) {
      inList = undefined;
    } else if (/^\S/.test(line)) {
      inTest = false;
      inList = undefined;
    }
  }
  return out;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function classify(script: string): "safe" | "live" | "unknown" {
  if (SAFE_PREFIXES.some((p) => script.startsWith(p))) return "safe";
  if (LIVE_PREFIXES.some((p) => script.startsWith(p))) return "live";
  return "unknown";
}

function runDemoScript(recipe: string, command: "compile" | "run", demo: string): Result {
  const script = `${command} ${demo}`;
  const start = Date.now();
  const result = spawnSync("bun", ["run", command, demo], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", CREWHAUS_LOG_LEVEL: "error" },
    timeout: 60_000,
  });
  const ms = Date.now() - start;
  if (result.status === 0) {
    process.stdout.write(`  ✓ ${script}  (${ms}ms)\n`);
    return { recipe, script, status: "passed" };
  }
  const tail =
    (result.stderr || "")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-3)
      .join("\n  ") || "(no stderr)";
  process.stderr.write(`  ✗ ${script}  (${ms}ms)\n  ${tail}\n`);
  return { recipe, script, status: "failed", reason: tail };
}

// Channel daemons need credentials beyond Anthropic to even bind. Skip them
// (rather than fail loudly) when those env vars are absent, matching the
// REQUIRES_ENV map below for the now-removed run:hello-channel alias.
const DEMO_REQUIRES_ENV: Record<string, readonly string[]> = {
  "hello-channel": ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"],
  "hello-channel-discord": ["DISCORD_BOT_TOKEN", "DISCORD_APPLICATION_ID"],
  "hello-channel-telegram": ["TELEGRAM_BOT_TOKEN"],
  "hello-channel-whatsapp": ["WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ACCESS_TOKEN"],
};

function maybeRunDemo(recipe: string, command: "run", demo: string): Result | undefined {
  const required = DEMO_REQUIRES_ENV[demo];
  if (required) {
    const missing = required.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      process.stdout.write(`  · ${command} ${demo}  (requires ${missing.join(", ")}; skipping)\n`);
      return {
        recipe,
        script: `${command} ${demo}`,
        status: "skipped",
        reason: `missing env: ${missing.join(", ")}`,
      };
    }
  }
  return runDemoScript(recipe, command, demo);
}

function runScript(recipe: string, script: string): Result {
  const start = Date.now();
  const result = spawnSync("bun", ["run", script], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    env: { ...process.env, NO_COLOR: "1", CREWHAUS_LOG_LEVEL: "error" },
    // Generous: codegen + bundling per shape takes a few seconds on
    // first run, sub-second after.
    timeout: 60_000,
  });
  const ms = Date.now() - start;
  if (result.status === 0) {
    process.stdout.write(`  ✓ ${script}  (${ms}ms)\n`);
    return { recipe, script, status: "passed" };
  }
  const tail =
    (result.stderr || "")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-3)
      .join("\n  ") || "(no stderr)";
  process.stderr.write(`  ✗ ${script}  (${ms}ms)\n  ${tail}\n`);
  return { recipe, script, status: "failed", reason: tail };
}

function main(): void {
  const recipes = readdirSync(WALKTHROUGHS_DIR)
    .filter((n) => n.endsWith(".md"))
    .sort();

  process.stdout.write(
    `Smoke runner — mode: ${LIVE ? "LIVE (run+smoke scripts enabled)" : "STATIC (compile-only)"}\n`,
  );

  for (const name of recipes) {
    const path = join(WALKTHROUGHS_DIR, name);
    const content = readFileSync(path, "utf-8");
    const fm = parseFrontmatter(content);
    const hasSpec = fm.spec !== undefined;
    const hasScripts = fm.bunScripts !== undefined && fm.bunScripts.length > 0;
    if (!hasSpec && !hasScripts) continue;

    const rel = relative(REPO_ROOT, path);
    process.stdout.write(`\n${rel}\n`);

    // Derive compile/run targets from `spec:` and run them through the
    // parameterized `compile`/`run` scripts. This replaces the per-demo
    // bun_scripts entries (compile:hello-X, run:hello-X) the recipes
    // used to carry — those scripts no longer exist in package.json.
    if (fm.spec !== undefined) {
      const demo = fm.spec.replace(/\/crewhaus\.ya?ml$/, "");
      results.push(runDemoScript(rel, "compile", demo));
      if (LIVE) {
        const liveResult = maybeRunDemo(rel, "run", demo);
        if (liveResult) results.push(liveResult);
      } else {
        process.stdout.write(`  · run ${demo}  (gated on RECIPE_SMOKE_LIVE=1; skipping)\n`);
        results.push({
          recipe: rel,
          script: `run ${demo}`,
          status: "skipped",
          reason: "live mode disabled",
        });
      }
    }

    if (!fm.bunScripts) continue;
    for (const script of fm.bunScripts) {
      const c = classify(script);
      if (c === "unknown") {
        process.stdout.write(`  ⚠ ${script}  (unknown prefix; skipping)\n`);
        results.push({ recipe: rel, script, status: "skipped", reason: "unknown prefix" });
        continue;
      }
      if (!loadDefinedScripts().has(script)) {
        process.stdout.write(`  · ${script}  (aspirational; not yet implemented; skipping)\n`);
        results.push({
          recipe: rel,
          script,
          status: "skipped",
          reason: "aspirational — not in package.json (gated by recipes:test allowlist)",
        });
        continue;
      }
      if (c === "live" && !LIVE) {
        process.stdout.write(`  · ${script}  (gated on RECIPE_SMOKE_LIVE=1; skipping)\n`);
        results.push({ recipe: rel, script, status: "skipped", reason: "live mode disabled" });
        continue;
      }
      const required = REQUIRES_ENV[script];
      if (required !== undefined) {
        const missing = required.filter((v) => !process.env[v]);
        if (missing.length > 0) {
          process.stdout.write(`  · ${script}  (requires ${missing.join(", ")}; skipping)\n`);
          results.push({
            recipe: rel,
            script,
            status: "skipped",
            reason: `missing env: ${missing.join(", ")}`,
          });
          continue;
        }
      }
      results.push(runScript(rel, script));
    }
  }

  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  process.stdout.write(`\nTotal: ${passed} passed, ${failed} failed, ${skipped} skipped.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
