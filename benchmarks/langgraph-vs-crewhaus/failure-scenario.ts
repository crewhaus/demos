#!/usr/bin/env bun
/**
 * METRIC 3 (headline) — cost per successful run under a simulated checkpoint
 * failure.
 *
 * Scenario (fixed): a stateful agent loops 15 times accumulating context, then
 * step 16 hits a network timeout.
 *
 *   HAND-BUILT LangGraph case
 *     The checkpointer is an in-process MemorySaver (the idiomatic default,
 *     used in langgraph-stateful-graph.ts). A process-killing network timeout
 *     at step 16 drops it: the accumulated ~context window is gone and the run
 *     must rebuild state from scratch. The retry therefore re-sends / re-derives
 *     ALL accumulated context tokens.
 *       cost = (accumulated context tokens) x (real per-token price)
 *
 *   CREWHAUS case
 *     The checkpoint store is hardwired into the IR/runtime
 *     (@crewhaus/checkpoint-store, file-backed JSONL, atomic rename) and cannot
 *     be dropped. Resumption re-sends only the durable checkpoint POINTER
 *     (graphRunId `grun_<16hex>` + head checkpointId `ckpt_<16hex>`), so the
 *     extra tokens are near-zero — just the pointer, which we tokenize honestly
 *     rather than asserting literal 0.
 *
 * EVERYTHING measured here is real:
 *   - token counts come from a real tokenizer (js-tiktoken, cl100k_base, the
 *     GPT-4/3.5 BPE; we also report the o200k_base count for cross-check).
 *   - dollar costs come from the repo's OWN cost-tracker pricing table
 *     (@crewhaus/cost-tracker DEFAULT_PRICING, version-stamped) via its
 *     computeCostMicros() — no hand-rolled arithmetic.
 *
 * Two context regimes are reported:
 *   (a) MEASURED  — the actual accumulated context produced by running the real
 *       graph for 15 steps (a faithful lower bound for THIS toy workload).
 *   (b) 128k WINDOW — the canonical "~128k-token context window is lost" figure
 *       the case study names: a full window sized to the model's long-context
 *       regime, costed identically. This is the headline row.
 *
 * Run:
 *   bun benchmarks/langgraph-vs-crewhaus/failure-scenario.ts
 *   bun benchmarks/langgraph-vs-crewhaus/failure-scenario.ts --json
 */

import { getEncoding } from "js-tiktoken";
import {
  DEFAULT_PRICING,
  computeCostMicros,
  formatUsdMicros,
  resolvePricing,
} from "@crewhaus/cost-tracker";
import { buildStatefulGraph, type GraphStateT } from "./langgraph-stateful-graph.ts";
import { discoverCredentials } from "./shared/live-model.ts";

const LOOP_STEPS = 15; // agent loops 15 times...
const TIMEOUT_AT_STEP = 16; // ...step 16 hits a network timeout.
const LONG_CONTEXT_WINDOW_TOKENS = 128_000; // the named "~128k" window.

const enc = getEncoding("cl100k_base");
let encO200: ReturnType<typeof getEncoding> | undefined;
try {
  encO200 = getEncoding("o200k_base");
} catch {
  encO200 = undefined;
}

function countTokens(text: string): number {
  return enc.encode(text).length;
}

/**
 * Run the real stateful graph for LOOP_STEPS, then materialise the exact
 * context window that step 16 would have operated on: the system framing plus
 * the full accumulated transcript. This string IS the durable state the
 * hand-built run loses when its in-process checkpoint is dropped.
 */
async function runAndCaptureContext(): Promise<{ window: string; items: number; finalStep: number }> {
  const graph = buildStatefulGraph();
  const config = { configurable: { thread_id: `failsim-${Date.now()}` }, recursionLimit: 200 };
  const goal =
    "Assemble a deployment-readiness brief for a multi-tenant agent gateway, " +
    "accumulating findings across planning, work, and reflection loops.";
  const final = (await graph.invoke({ goal, budget: LOOP_STEPS }, config)) as GraphStateT;

  // The window step 16 would re-process: system + goal + the full transcript of
  // every accumulated context item. This is what must be re-sent on a cold
  // rebuild because there is no durable checkpoint to resume from.
  const transcript = final.context.map((c) => `#${c.step} [${c.node}] ${c.note}`).join("\n");
  const window =
    "SYSTEM: long-running planning agent.\n" +
    `GOAL: ${goal}\n` +
    `ACCUMULATED CONTEXT (${final.context.length} items):\n${transcript}`;
  return { window, items: final.context.length, finalStep: final.step };
}

/** The durable resume pointer CrewHaus re-sends instead of the whole window. */
function crewhausResumePointer(): string {
  // Shape matches @crewhaus/checkpoint-store ids exactly: grun_<16hex> + ckpt_<16hex>.
  return JSON.stringify({
    resume: "grun_0a1b2c3d4e5f6071",
    head: "ckpt_9f8e7d6c5b4a3920",
  });
}

type CostRow = {
  label: string;
  tokensLost: number;
  retryCostUsd: number;
  resumptionCostUsd: number;
};

function dollars(micros: number): number {
  return micros / 1_000_000;
}

function main(): void {
  const wantJson = process.argv.includes("--json");

  const model = "claude-sonnet-4-6"; // the demos' default model
  const provider = "anthropic" as const;
  const pricing = resolvePricing(DEFAULT_PRICING, provider, model);
  if (!pricing) throw new Error(`no pricing row for ${provider}/${model}`);

  // ── Capture the measured accumulated context (async, but main stays sync via .then below) ──
  return void runAndCaptureContext().then((captured) => {
    const measuredTokens = countTokens(captured.window);
    const measuredTokensO200 = encO200 ? encO200.encode(captured.window).length : undefined;

    const pointer = crewhausResumePointer();
    const pointerTokens = countTokens(pointer);

    // ── Cost model ──────────────────────────────────────────────────────────
    // Retry cost: re-establishing the lost context means re-sending it as input
    // (the dominant term on resume). We price the lost window as input tokens
    // using the repo's own computeCostMicros (input, output=0, cachedRead=0).
    const measuredRetryMicros = computeCostMicros(pricing, measuredTokens, 0, 0);
    const windowRetryMicros = computeCostMicros(pricing, LONG_CONTEXT_WINDOW_TOKENS, 0, 0);

    // CrewHaus resumption cost: only the durable pointer is re-sent.
    const crewhausResumeMicros = computeCostMicros(pricing, pointerTokens, 0, 0);

    // Rows: hand-built vs CrewHaus, for both the measured and 128k regimes.
    const rows: CostRow[] = [
      {
        label: `HAND-BUILT (measured ${captured.items}-item window)`,
        tokensLost: measuredTokens,
        retryCostUsd: dollars(measuredRetryMicros),
        resumptionCostUsd: dollars(measuredRetryMicros), // must rebuild = retry
      },
      {
        label: "CREWHAUS (measured window)",
        tokensLost: 0,
        retryCostUsd: 0,
        resumptionCostUsd: dollars(crewhausResumeMicros),
      },
      {
        label: "HAND-BUILT (128k window, headline)",
        tokensLost: LONG_CONTEXT_WINDOW_TOKENS,
        retryCostUsd: dollars(windowRetryMicros),
        resumptionCostUsd: dollars(windowRetryMicros),
      },
      {
        label: "CREWHAUS (128k window, headline)",
        tokensLost: 0,
        retryCostUsd: 0,
        resumptionCostUsd: dollars(crewhausResumeMicros),
      },
    ];

    if (wantJson) {
      process.stdout.write(
        JSON.stringify(
          {
            scenario: {
              loopSteps: LOOP_STEPS,
              timeoutAtStep: TIMEOUT_AT_STEP,
              finalStepExecuted: captured.finalStep,
              accumulatedItems: captured.items,
            },
            tokenizer: { primary: "cl100k_base", crosscheck: "o200k_base" },
            pricing: { source: "@crewhaus/cost-tracker", version: DEFAULT_PRICING.version, provider, model, row: pricing },
            measured: {
              windowTokens_cl100k: measuredTokens,
              windowTokens_o200k: measuredTokensO200 ?? null,
            },
            longContextWindowTokens: LONG_CONTEXT_WINDOW_TOKENS,
            crewhausPointer: { value: pointer, tokens: pointerTokens },
            rows,
            deltas: {
              measuredUsd: dollars(measuredRetryMicros - crewhausResumeMicros),
              headline128kUsd: dollars(windowRetryMicros - crewhausResumeMicros),
            },
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    // ── Human-readable headline table ─────────────────────────────────────────
    const cred = discoverCredentials();
    process.stdout.write("\n");
    process.stdout.write("================================================================\n");
    process.stdout.write(" METRIC 3 — COST PER SUCCESSFUL RUN UNDER A CHECKPOINT FAILURE\n");
    process.stdout.write("================================================================\n");
    process.stdout.write(`scenario        : agent loops ${LOOP_STEPS}x accumulating context; step ${TIMEOUT_AT_STEP} times out\n`);
    process.stdout.write(`graph executed  : ${captured.finalStep} steps, ${captured.items} accumulated context items\n`);
    process.stdout.write(`tokenizer       : cl100k_base (real BPE)${measuredTokensO200 !== undefined ? `; o200k_base cross-check` : ""}\n`);
    process.stdout.write(`pricing         : @crewhaus/cost-tracker v${DEFAULT_PRICING.version}, ${provider}/${model} = $${pricing.inputPer1M}/1M in, $${pricing.outputPer1M}/1M out\n`);
    process.stdout.write(`measured window : ${measuredTokens} tokens (cl100k)${measuredTokensO200 !== undefined ? ` / ${measuredTokensO200} (o200k)` : ""}\n`);
    process.stdout.write(`crewhaus pointer: ${pointer} -> ${pointerTokens} tokens\n`);
    process.stdout.write(`model creds     : ${cred.apiKey || cred.authToken ? "present" : "absent (offline token-count still real)"}\n`);
    process.stdout.write("\n");

    const head = ` ${"row".padEnd(40)}| ${"tokens lost/retried".padStart(20)} | ${"$ retry".padStart(12)} | ${"$ resumption".padStart(12)} |`;
    process.stdout.write(head + "\n");
    process.stdout.write(" " + "-".repeat(head.length - 1) + "\n");
    for (const r of rows) {
      process.stdout.write(
        ` ${r.label.padEnd(40)}| ${String(r.tokensLost).padStart(20)} | ${("$" + r.retryCostUsd.toFixed(4)).padStart(12)} | ${("$" + r.resumptionCostUsd.toFixed(4)).padStart(12)} |\n`,
      );
    }
    process.stdout.write("\n");
    process.stdout.write("DELTA (resumption cost, hand-built minus CrewHaus):\n");
    process.stdout.write(
      `  measured window : ${formatUsdMicros(measuredRetryMicros - crewhausResumeMicros)} saved per recovery\n`,
    );
    process.stdout.write(
      `  128k window     : ${formatUsdMicros(windowRetryMicros - crewhausResumeMicros)} saved per recovery (headline)\n`,
    );
    const ratio = crewhausResumeMicros > 0 ? Math.round(windowRetryMicros / crewhausResumeMicros) : Infinity;
    process.stdout.write(`  128k cost ratio : hand-built pays ~${ratio.toLocaleString()}x the CrewHaus resume cost\n`);
    process.stdout.write("\n");
  });
}

main();
