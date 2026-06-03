#!/usr/bin/env bun
/**
 * Workload (B) — NATIVE, HAND-BUILT LangGraph stateful graph with a checkpoint
 * saver, modelling a long-running loop that accumulates context over 15+ steps.
 *
 * This is the labour the CrewHaus compiler avoids. The equivalent CrewHaus
 * artifact is `demos/starters/graph/crewhaus.yaml` (28 authored lines) which
 * emits `demos/starters/graph/dist/agent.ts` (171 lines) whose orchestration is
 * NOT inlined — it imports `@crewhaus/graph-engine` (618 LOC of builder +
 * interpreter), `@crewhaus/checkpoint-store` (351 LOC of durable, branchable
 * state) and `@crewhaus/run-context` from a shared runtime-core. The emitted
 * bundle is thin glue; the checkpoint store is hardwired into the IR/runtime
 * and cannot be dropped.
 *
 * Here, a LangGraph engineer must assemble it by hand:
 *   - an explicit state schema (Annotation.Root) with an accumulating-context
 *     reducer and a step counter
 *   - several node definitions (plan, work, reflect, finalize)
 *   - CONDITIONAL EDGES: a router that loops work→reflect→work until a budget
 *     of steps is reached, then routes to finalize
 *   - a CHECKPOINT SAVER (MemorySaver) wired through compile({ checkpointer })
 *     and a thread_id so the run is resumable
 *
 * The same module is imported by failure-scenario.ts to drive metric 3, where
 * we show what it costs when the (in-process) MemorySaver checkpoint is dropped
 * by a crash at step 16 and the accumulated context must be rebuilt.
 *
 * Run:
 *   bun benchmarks/langgraph-vs-crewhaus/langgraph-stateful-graph.ts
 *   bun benchmarks/langgraph-vs-crewhaus/langgraph-stateful-graph.ts --steps 18
 */

import { Annotation, StateGraph, MemorySaver, START, END } from "@langchain/langgraph";
import { callModel, type ChatMessage } from "./shared/live-model.ts";

// ─────────────────────────────────────────────────────────────────────────────
// State schema. The accumulating `context` channel is the heart of the long-
// running-loop model: each step appends a record, so by step N the channel
// holds the full derived history. `step` and `budget` drive the conditional
// loop. CrewHaus infers all of this from the spec's nodes + edges block.
// ─────────────────────────────────────────────────────────────────────────────
// @metric:state-schema:start
export type ContextItem = {
  step: number;
  node: string;
  note: string;
};

const GraphState = Annotation.Root({
  goal: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  // Append-only accumulator — the reducer concatenates rather than replaces.
  context: Annotation<ContextItem[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  step: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  budget: Annotation<number>({
    reducer: (prev, next) => next ?? prev,
    default: () => 15,
  }),
  scratch: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  done: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  finalSummary: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

export type GraphStateT = typeof GraphState.State;
// @metric:state-schema:end

const SYSTEM_PROMPT =
  "You are a long-running planning agent working a multi-step task. On each " +
  "turn you receive the accumulated context so far and must produce one short " +
  "concrete next finding (one sentence). Stay grounded in the context; do not " +
  "repeat earlier findings verbatim.";

// @metric:node-defs:start
/**
 * Produce one step's note. Uses the live model when credentials exist, else a
 * deterministic synthetic note so the loop runs offline and is reproducible.
 * Either way the note is appended to the accumulating context channel.
 */
async function deriveNote(node: string, state: GraphStateT): Promise<string> {
  const transcript = state.context
    .map((c) => `#${c.step} [${c.node}] ${c.note}`)
    .join("\n");
  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        `Goal: ${state.goal}\n\n` +
        `Accumulated context (${state.context.length} items):\n${transcript || "(empty)"}\n\n` +
        `You are the "${node}" node at step ${state.step + 1}. Produce the next finding.`,
    },
  ];
  const res = await callModel({ system: SYSTEM_PROMPT, messages, maxTokens: 128 });
  if (res.ok && res.text.trim() !== "") return res.text.trim();
  // Offline synthetic note (deterministic, references prior step count).
  return `[${node}] step ${state.step + 1}: derived finding building on ${state.context.length} prior items (offline).`;
}

// ─── Node: plan (entry) ──────────────────────────────────────────────────────
async function planNode(state: GraphStateT): Promise<Partial<GraphStateT>> {
  const note = await deriveNote("plan", state);
  const step = state.step + 1;
  process.stderr.write(`[graph] plan        step=${step}\n`);
  return { step, scratch: note, context: [{ step, node: "plan", note }] };
}

// ─── Node: work ──────────────────────────────────────────────────────────────
async function workNode(state: GraphStateT): Promise<Partial<GraphStateT>> {
  const note = await deriveNote("work", state);
  const step = state.step + 1;
  process.stderr.write(`[graph] work        step=${step}\n`);
  return { step, scratch: note, context: [{ step, node: "work", note }] };
}

// ─── Node: reflect ───────────────────────────────────────────────────────────
async function reflectNode(state: GraphStateT): Promise<Partial<GraphStateT>> {
  const note = await deriveNote("reflect", state);
  const step = state.step + 1;
  const done = step >= state.budget;
  process.stderr.write(`[graph] reflect     step=${step} done=${done}\n`);
  return { step, scratch: note, done, context: [{ step, node: "reflect", note }] };
}

// ─── Node: finalize ──────────────────────────────────────────────────────────
async function finalizeNode(state: GraphStateT): Promise<Partial<GraphStateT>> {
  const transcript = state.context.map((c) => `#${c.step} [${c.node}] ${c.note}`).join("\n");
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Goal: ${state.goal}\n\nFull accumulated context:\n${transcript}\n\nWrite a 2-sentence executive summary.`,
    },
  ];
  const res = await callModel({ system: SYSTEM_PROMPT, messages, maxTokens: 256 });
  const summary = res.ok && res.text.trim() !== ""
    ? res.text.trim()
    : `Completed ${state.context.length} steps toward: ${state.goal} (offline summary).`;
  process.stderr.write(`[graph] finalize    step=${state.step}\n`);
  return { finalSummary: summary };
}
// @metric:node-defs:end

// ─────────────────────────────────────────────────────────────────────────────
// CONDITIONAL EDGE: after each work→reflect cycle, loop back to work until the
// step budget is hit, then go to finalize. This router is the explicit control
// flow LOC the metric counts; CrewHaus expresses it as `edges:` in the spec.
// ─────────────────────────────────────────────────────────────────────────────
// @metric:conditional-edges:start
function routeAfterReflect(state: GraphStateT): "work" | "finalize" {
  return state.done ? "finalize" : "work";
}
// @metric:conditional-edges:end

// ─────────────────────────────────────────────────────────────────────────────
// Graph + checkpoint saver wiring. MemorySaver persists state per super-step
// keyed by thread_id. compile({ checkpointer }) is the hand-wired durability
// the engineer must remember to add — and which, being in-process, is lost on
// a crash (see failure-scenario.ts).
// ─────────────────────────────────────────────────────────────────────────────
// @metric:checkpoint-wiring:start
export function buildStatefulGraph(checkpointer = new MemorySaver()) {
  return new StateGraph(GraphState)
    .addNode("plan", planNode)
    .addNode("work", workNode)
    .addNode("reflect", reflectNode)
    .addNode("finalize", finalizeNode)
    .addEdge(START, "plan")
    .addEdge("plan", "work")
    .addEdge("work", "reflect")
    .addConditionalEdges("reflect", routeAfterReflect, {
      work: "work",
      finalize: "finalize",
    })
    .addEdge("finalize", END)
    .compile({ checkpointer });
}
// @metric:checkpoint-wiring:end

// ─── Entrypoint ──────────────────────────────────────────────────────────────
function parseSteps(argv: string[]): number {
  const i = argv.indexOf("--steps");
  if (i >= 0 && argv[i + 1]) {
    const n = Number.parseInt(argv[i + 1] as string, 10);
    if (Number.isFinite(n) && n >= 3) return n;
  }
  return 15;
}

async function main(): Promise<void> {
  const budget = parseSteps(process.argv.slice(2));
  const checkpointer = new MemorySaver();
  const graph = buildStatefulGraph(checkpointer);
  const threadId = `bench-${Date.now()}`;
  const config = { configurable: { thread_id: threadId }, recursionLimit: 200 };

  const goal =
    "Assemble a deployment-readiness brief for a multi-tenant agent gateway, " +
    "accumulating findings across planning, work, and reflection loops.";

  const startedAt = Date.now();
  const final = await graph.invoke({ goal, budget }, config);
  const elapsedMs = Date.now() - startedAt;

  // Confirm the checkpoint saver actually persisted state for this thread.
  const tuple = await checkpointer.get(config);

  process.stdout.write("\n=== HAND-BUILT LANGGRAPH STATEFUL GRAPH ===\n");
  process.stdout.write(`thread_id      : ${threadId}\n`);
  process.stdout.write(`budget (steps) : ${budget}\n`);
  process.stdout.write(`steps executed : ${final.step}\n`);
  process.stdout.write(`context items  : ${final.context.length}\n`);
  process.stdout.write(`checkpoint     : ${tuple ? "persisted (MemorySaver)" : "MISSING"}\n`);
  process.stdout.write(`summary        :\n${final.finalSummary}\n`);
  process.stdout.write(`elapsed        : ${elapsedMs} ms\n`);
}

if (import.meta.main) {
  await main();
}
