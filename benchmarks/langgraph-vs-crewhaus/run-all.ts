#!/usr/bin/env bun
/**
 * Master harness — runs the full empirical case study end-to-end and prints
 * every measured metric in order:
 *
 *   metric 1  boilerplate / LOC (granular)            metric-loc.ts
 *   metric 2  cold-start deployment time              metric-coldstart.ts
 *   metric 3  cost per run under checkpoint failure    failure-scenario.ts
 *   live      full live run (real latency + spend)    metric-liverun.ts
 *
 * Each sub-metric is also independently runnable. Pass --warm to skip the
 * cold-cache install measurement in metric 2 (faster, no cache mutation).
 *
 * Run:
 *   bun benchmarks/langgraph-vs-crewhaus/run-all.ts
 *   bun benchmarks/langgraph-vs-crewhaus/run-all.ts --warm
 */

import { spawnSync } from "node:child_process";

const HERE = new URL(".", import.meta.url).pathname;
const warm = process.argv.includes("--warm");

function run(label: string, file: string, args: string[] = []): void {
  process.stdout.write(`\n\n##### ${label} #####\n`);
  const r = spawnSync("bun", [`${HERE}${file}`, ...args], { stdio: "inherit" });
  if (r.status !== 0) {
    process.stderr.write(`[run-all] ${file} exited ${r.status}\n`);
  }
}

process.stdout.write("LangGraph (hand-built) vs CrewHaus (compiled) — empirical case study\n");
process.stdout.write("====================================================================\n");

run("METRIC 1: BOILERPLATE / LOC", "metric-loc.ts");
run("METRIC 2: COLD-START DEPLOYMENT TIME", "metric-coldstart.ts", warm ? ["--warm"] : []);
run("METRIC 3: COST UNDER CHECKPOINT FAILURE", "failure-scenario.ts");
run("FULL LIVE RUN", "metric-liverun.ts");

process.stdout.write("\n\nDone. Re-run any sub-metric individually; pass --json to any for machine output.\n");
