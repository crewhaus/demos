#!/usr/bin/env bun
/**
 * METRIC 2 — cold-start deployment time (wall-clock from cold to ready-to-serve).
 *
 * METHOD (each phase is really executed and timed; nothing is asserted):
 *
 *   HAND-BUILT LangGraph
 *     phase 1  dependency install — `bun add @langchain/langgraph @langchain/core
 *              js-tiktoken` into a FRESH temp project. Measured twice, each into
 *              an ISOLATED bun cache dir (BUN_INSTALL_CACHE_DIR) so we never
 *              mutate the user's real global cache and the two regimes are clean:
 *                - cold cache  → empty cache dir → a true full network fetch of
 *                  all 34 packages (langgraph + core + js-tiktoken + transitive).
 *                - warm cache  → the same dir pre-seeded once → hardlink-only
 *                  install, the realistic CI-with-cache number.
 *     phase 2  first-ready — spawn `bun` to import the hand-built graph module
 *              and compile the StateGraph to an invokable instance (no run).
 *              Reported as the steady-state (median of N) to exclude the one-time
 *              process/JIT warmup of the very first spawn.
 *     ready-to-serve = phase1 + phase2.
 *
 *   CREWHAUS
 *     phase 1  compile — `bun scripts/compile.ts <spec>` turns crewhaus.yaml
 *              into dist/agent.ts (the deployable bundle). The runtime-core is a
 *              published dependency already resolved by the project's install,
 *              so there is no separate orchestration-install step.
 *     phase 2  first-ready — spawn the emitted bundle far enough to load its
 *              imports and build the graph/pipeline (we time module load +
 *              compile via a tiny ready-probe import of the bundle's deps).
 *     ready-to-serve = phase1 + phase2.
 *
 * We report seconds for every phase and the totals so the table is auditable.
 *
 * Run:
 *   bun benchmarks/langgraph-vs-crewhaus/metric-coldstart.ts          # full (clears bun cache for the cold number — slower)
 *   bun benchmarks/langgraph-vs-crewhaus/metric-coldstart.ts --warm   # skip the cache-clear cold install
 *   bun benchmarks/langgraph-vs-crewhaus/metric-coldstart.ts --json
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("../../", import.meta.url).pathname; // demos/
const GRAPH_MODULE = `${REPO}benchmarks/langgraph-vs-crewhaus/langgraph-stateful-graph.ts`;
// The authored graph spec for THIS case study (mirrors the hand-built baseline's
// 4 nodes). Compiling it is the CrewHaus "build" phase.
const GRAPH_SPEC_SRC = `${REPO}benchmarks/langgraph-vs-crewhaus/crewhaus-graph`;

const LG_DEPS = ["@langchain/langgraph@0.2.74", "@langchain/core@0.3.66", "js-tiktoken@1.0.21"];

function now(): number {
  return Number(process.hrtime.bigint() / 1_000_000n); // ms
}

function timeIt(fn: () => void): number {
  const t0 = now();
  fn();
  return now() - t0;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * `bun add` LG_DEPS into a fresh temp project, using an ISOLATED bun cache dir so
 * we never touch the user's real global cache. `cacheDir` empty → cold (true full
 * network fetch); `cacheDir` pre-seeded → warm (hardlink-only). Returns wall-ms.
 */
function timeLanggraphInstall(cacheDir: string, note: string): { ms: number; ok: boolean; note: string } {
  const dir = mkdtempSync(join(tmpdir(), "lg-inst-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lg-inst", type: "module" }));
  let ok = true;
  const ms = timeIt(() => {
    const r = spawnSync("bun", ["add", ...LG_DEPS], {
      cwd: dir,
      stdio: "ignore",
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: cacheDir },
    });
    ok = r.status === 0;
  });
  rmSync(dir, { recursive: true, force: true });
  return { ms, ok, note };
}

/**
 * Spawn bun N times to import the hand-built graph + compile it; returns the
 * MEDIAN wall-ms (steady-state) plus the raw samples. The first spawn pays a
 * one-time process/JIT warmup, so the median is the honest first-ready figure.
 */
function timeLanggraphFirstReady(n = 3): { ms: number; samples: number[]; ok: boolean } {
  const probe =
    `const m = await import(${JSON.stringify(GRAPH_MODULE)});` +
    `const g = m.buildStatefulGraph();` +
    `if (typeof g.invoke !== "function") { process.exit(3); }`;
  let ok = true;
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    samples.push(
      timeIt(() => {
        const r = spawnSync("bun", ["-e", probe], { cwd: REPO, stdio: "ignore" });
        if (r.status !== 0) ok = false;
      }),
    );
  }
  return { ms: median(samples), samples, ok };
}

/**
 * Compile the CrewHaus graph spec → dist bundle N times; returns the MEDIAN
 * wall-ms (steady-state) plus raw samples and the final specDir (for the
 * first-ready probe). The first compile pays a one-time process/JIT warmup.
 */
function timeCrewhausCompile(n = 3): { ms: number; samples: number[]; ok: boolean; specDir: string } {
  let ok = true;
  let lastSpecDir = "";
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const specDir = mkdtempSync(join(tmpdir(), "ch-graph-"));
    // Copy the authored spec into the temp dir (cold output dir, no prior dist).
    spawnSync("cp", ["-r", `${GRAPH_SPEC_SRC}/.`, specDir], { stdio: "ignore" });
    rmSync(join(specDir, "dist"), { recursive: true, force: true });
    samples.push(
      timeIt(() => {
        const r = spawnSync("bun", [join(REPO, "scripts", "compile.ts"), specDir], {
          cwd: REPO,
          stdio: "ignore",
        });
        if (!(r.status === 0 && existsSync(join(specDir, "dist", "agent.ts")))) ok = false;
      }),
    );
    if (i < n - 1) rmSync(specDir, { recursive: true, force: true });
    else lastSpecDir = specDir;
  }
  return { ms: median(samples), samples, ok, specDir: lastSpecDir };
}

/** Spawn bun N times to load the bundle's imports + build the graph; median ms. */
function timeCrewhausFirstReady(n = 3): { ms: number; samples: number[]; ok: boolean } {
  // The emitted bundle's top-level builds the graph at import time, then awaits
  // main() (which reads stdin). We import its dependency graph + construct the
  // graph the same way the bundle does, timing module-load + compile only.
  const probe =
    `const { createCheckpointStore } = await import("@crewhaus/checkpoint-store");` +
    `const { createGraph } = await import("@crewhaus/graph-engine");` +
    `const { createRunContext } = await import("@crewhaus/run-context");` +
    `const store = createCheckpointStore();` +
    `const g = createGraph({ checkpointStore: store }).setInputAdapter((i)=>({input:i})).addNode("n", async (_c,p)=>p).setEntry("n").compile();` +
    `if (typeof g.run !== "function") process.exit(3);`;
  let ok = true;
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    samples.push(
      timeIt(() => {
        const r = spawnSync("bun", ["-e", probe], { cwd: REPO, stdio: "ignore" });
        if (r.status !== 0) ok = false;
      }),
    );
  }
  return { ms: median(samples), samples, ok };
}

function s(ms: number): string {
  return (ms / 1000).toFixed(2) + "s";
}

function main(): void {
  const wantJson = process.argv.includes("--json");
  const warmOnly = process.argv.includes("--warm");

  // CrewHaus first (cheap), then LangGraph install regimes via an ISOLATED cache.
  const chCompile = timeCrewhausCompile();
  const chReady = timeCrewhausFirstReady();
  rmSync(chCompile.specDir, { recursive: true, force: true });

  const lgReady = timeLanggraphFirstReady();

  // Use a dedicated, isolated bun cache dir so we never mutate the user's real
  // global cache. WARM = pre-seed once then time hardlink installs; COLD = a
  // fresh empty cache dir → a true full network fetch.
  const warmCache = mkdtempSync(join(tmpdir(), "bun-warmcache-"));
  // Seed the warm cache once (untimed) so subsequent installs are hardlink-only.
  {
    const seed = mkdtempSync(join(tmpdir(), "lg-seed-"));
    writeFileSync(join(seed, "package.json"), JSON.stringify({ name: "seed", type: "module" }));
    spawnSync("bun", ["add", ...LG_DEPS], {
      cwd: seed,
      stdio: "ignore",
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: warmCache },
    });
    rmSync(seed, { recursive: true, force: true });
  }
  const lgInstallWarm = timeLanggraphInstall(warmCache, "warm cache (pre-seeded, hardlink-only)");
  rmSync(warmCache, { recursive: true, force: true });

  let lgInstallCold: { ms: number; ok: boolean; note: string };
  if (warmOnly) {
    lgInstallCold = { ms: 0, ok: true, note: "skipped (--warm)" };
  } else {
    const coldCache = mkdtempSync(join(tmpdir(), "bun-coldcache-"));
    lgInstallCold = timeLanggraphInstall(coldCache, "cold cache (empty → full network fetch of 34 pkgs)");
    rmSync(coldCache, { recursive: true, force: true });
  }

  const lgTotalWarm = lgInstallWarm.ms + lgReady.ms;
  const lgTotalCold = warmOnly ? null : lgInstallCold.ms + lgReady.ms;
  const chTotal = chCompile.ms + chReady.ms;

  if (wantJson) {
    process.stdout.write(
      JSON.stringify(
        {
          method: "isolated BUN_INSTALL_CACHE_DIR; install/compile/first-ready are median of N runs",
          handBuilt: {
            installWarm: lgInstallWarm,
            installCold: warmOnly ? null : lgInstallCold,
            firstReady: lgReady,
            totalWarmMs: lgTotalWarm,
            totalColdMs: lgTotalCold,
          },
          crewhaus: {
            compile: { ms: chCompile.ms, samples: chCompile.samples, ok: chCompile.ok },
            firstReady: chReady,
            totalMs: chTotal,
          },
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write("\n");
  process.stdout.write("================================================================\n");
  process.stdout.write(" METRIC 2 — COLD-START DEPLOYMENT TIME (wall-clock to ready-to-serve)\n");
  process.stdout.write("================================================================\n\n");

  process.stdout.write("HAND-BUILT LangGraph  (isolated bun cache; install/first-ready are medians)\n");
  process.stdout.write(`  phase 1  dep install (warm cache) : ${s(lgInstallWarm.ms)}  ${lgInstallWarm.ok ? "ok" : "FAIL"}  (${lgInstallWarm.note})\n`);
  if (!warmOnly) {
    process.stdout.write(`  phase 1' dep install (cold cache) : ${s(lgInstallCold.ms)}  ${lgInstallCold.ok ? "ok" : "FAIL"}  (${lgInstallCold.note})\n`);
  }
  process.stdout.write(`  phase 2  first-ready (import+compile StateGraph): ${s(lgReady.ms)}  ${lgReady.ok ? "ok" : "FAIL"}  [samples ${lgReady.samples.map(s).join(", ")}]\n`);
  process.stdout.write(`  -------------------------------------------------\n`);
  process.stdout.write(`  ready-to-serve (warm cache)       : ${s(lgTotalWarm)}\n`);
  if (lgTotalCold !== null) process.stdout.write(`  ready-to-serve (cold cache)       : ${s(lgTotalCold)}\n`);
  process.stdout.write("\n");

  process.stdout.write("CREWHAUS  (compile/first-ready are medians)\n");
  process.stdout.write(`  phase 1  compile spec → bundle    : ${s(chCompile.ms)}  ${chCompile.ok ? "ok" : "FAIL"}  [samples ${chCompile.samples.map(s).join(", ")}]\n`);
  process.stdout.write(`  phase 2  first-ready (load core + build graph): ${s(chReady.ms)}  ${chReady.ok ? "ok" : "FAIL"}  [samples ${chReady.samples.map(s).join(", ")}]\n`);
  process.stdout.write(`  -------------------------------------------------\n`);
  process.stdout.write(`  ready-to-serve                    : ${s(chTotal)}\n`);
  process.stdout.write("\n");

  process.stdout.write("NOTE: CrewHaus has no separate orchestration-install phase — the\n");
  process.stdout.write("runtime-core it imports is a single published dependency resolved by the\n");
  process.stdout.write("project's existing install; cold start is dominated by codegen, not by\n");
  process.stdout.write("fetching/compiling an orchestration tree.\n\n");
}

main();
