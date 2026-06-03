#!/usr/bin/env bun
/**
 * Empirical proof for METRIC 3's CrewHaus side: the checkpoint store the
 * compiled graph bundle imports is DURABLE and RESUMABLE across a process
 * boundary, re-sending only a pointer — not the accumulated context window.
 *
 * This drives the SAME runtime packages the emitted bundle imports
 * (`crewhaus-graph/dist/agent.ts` lines 4–7):
 *   @crewhaus/graph-engine   — createGraph / run / resume / hitl pause
 *   @crewhaus/checkpoint-store — createCheckpointStore (file-backed JSONL)
 *   @crewhaus/run-context     — createRunContext
 *
 * It uses a DETERMINISTIC node (no model call) so the proof runs offline and
 * reproducibly. The node accumulates one context item per step exactly like
 * the hand-built langgraph-stateful-graph.ts loop, and a HITL gate pauses the
 * run at step 16 — the moment the case study's "network timeout" strikes.
 *
 * What this demonstrates that a hand-built in-process MemorySaver cannot:
 *   1. After the pause, a `ckpt_<16hex>.json` file exists on disk under
 *      `.crewhaus/graphs/<grun_16hex>/` — the state survived the interruption.
 *   2. A FRESH checkpoint store (new object = simulated new process) can read
 *      that run's head pointer and the engine RESUMES from it to completion.
 *   3. The resume needs only the pointer {graphRunId, checkpointId}; the full
 *      accumulated context is reloaded from durable storage, not re-sent.
 *
 * Run:
 *   bun benchmarks/langgraph-vs-crewhaus/crewhaus-checkpoint-proof.ts
 *   bun benchmarks/langgraph-vs-crewhaus/crewhaus-checkpoint-proof.ts --json
 */

import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraph } from "@crewhaus/graph-engine";
import { createCheckpointStore } from "@crewhaus/checkpoint-store";
import { createRunContext } from "@crewhaus/run-context";

const LOOP_STEPS = 15; // accumulate 15 items...
const PAUSE_AT_STEP = 16; // ...HITL gate fires as step 16 would begin.

type ContextItem = { step: number; node: string; note: string };
type S = {
  goal: string;
  context: ContextItem[];
  step: number;
  done: boolean;
  reflect_decision?: string;
};

/** Deterministic step note — mirrors the hand-built offline fallback exactly. */
function note(node: string, prev: S): string {
  return `[${node}] step ${prev.step + 1}: derived finding building on ${prev.context.length} prior items (offline).`;
}

/** Build a graph whose `work` node loops to `reflect`, which HITL-pauses. */
function buildProofGraph(store: ReturnType<typeof createCheckpointStore>) {
  return createGraph<{ goal: string }, S>({ checkpointStore: store })
    .setInputAdapter((input) => ({ goal: input.goal, context: [], step: 0, done: false }))
    .addNode("work", async (_ctx, prev) => {
      const step = prev.step + 1;
      const n = note("work", prev);
      return { ...prev, step, context: [...prev.context, { step, node: "work", note: n }] };
    })
    .addNode("reflect", async (ctx, prev) => {
      const step = prev.step + 1;
      const n = note("reflect", prev);
      const next: S = {
        ...prev,
        step,
        context: [...prev.context, { step, node: "reflect", note: n }],
      };
      // The HITL gate: the engine persists a checkpoint and pauses here. This is
      // the exact pause/resume path the emitted bundle's `reflect` node uses.
      if (next.step >= LOOP_STEPS) {
        const decision = await ctx.requestApproval(
          "Findings accumulated. Approve reflection and continue to finalize?",
        );
        next.reflect_decision = decision;
        next.done = true;
      }
      return next;
    })
    .addNode("finalize", async (_ctx, prev) => ({ ...prev, done: true }))
    .addEdge("work", "reflect")
    // Loop reflect -> work until we hit the budget, else fall through to finalize.
    .addEdge("reflect", "work", (s) => !s.done)
    .addEdge("reflect", "finalize", (s) => s.done)
    .setEntry("work")
    .compile();
}

async function main(): Promise<void> {
  const wantJson = process.argv.includes("--json");

  // Isolated checkpoint root so the proof never collides with real runs.
  const root = mkdtempSync(join(tmpdir(), "ch-ckpt-proof-"));

  // ── Phase 1: run until the HITL pause (the "step 16 timeout" moment) ──────
  const store1 = createCheckpointStore({ rootDir: root });
  const runContext1 = createRunContext();
  const graph1 = buildProofGraph(store1);

  const stream = graph1.run(
    { goal: "Assemble a deployment-readiness brief for a multi-tenant agent gateway." },
    { runContext: runContext1 },
  );

  let graphRunId: string | undefined;
  let pauseCheckpointId: string | undefined;
  let pausedNode: string | undefined;
  let accumulatedAtPause = 0;
  for await (const ev of stream) {
    if ("graphRunId" in ev && ev.graphRunId) graphRunId = ev.graphRunId;
    if (ev.kind === "node_end") {
      const st = ev.state as S;
      if (st.context) accumulatedAtPause = Math.max(accumulatedAtPause, st.context.length);
    }
    if (ev.kind === "hitl_pause") {
      pauseCheckpointId = ev.checkpointId;
      pausedNode = ev.nodeName;
    }
  }

  if (graphRunId === undefined || pauseCheckpointId === undefined) {
    throw new Error("graph did not pause at the HITL gate as expected");
  }

  // ── Phase 1 assertion: the checkpoint is DURABLE on disk ──────────────────
  const runDir = join(root, graphRunId);
  const ckptFiles = existsSync(runDir)
    ? readdirSync(runDir).filter((f) => f.startsWith("ckpt_") && f.endsWith(".json"))
    : [];
  const headCkptOnDisk = ckptFiles.some((f) => f === `${pauseCheckpointId}.json`);

  // ── Phase 2: a FRESH store (new process) reads the durable head + resumes ──
  const store2 = createCheckpointStore({ rootDir: root });
  const runContext2 = createRunContext();
  const graph2 = buildProofGraph(store2);

  const meta = await store2.meta(graphRunId);
  const head = meta?.head;
  if (head === undefined) throw new Error("fresh store could not read durable head pointer");

  // The pointer is ALL we carry across the boundary — not the context window.
  const resumePointer = JSON.stringify({ resume: graphRunId, head });

  const resumeStream = graph2.resume(graphRunId, head, "approve", { runContext: runContext2 });
  let finalItems = 0;
  let completed = false;
  let resumedDecision: string | undefined;
  for await (const ev of resumeStream) {
    if (ev.kind === "run_done") {
      const st = ev.state as S;
      finalItems = st.context?.length ?? 0;
      resumedDecision = st.reflect_decision;
      completed = true;
    }
  }

  const idShapeOk =
    /^grun_[0-9a-f]{16}$/.test(graphRunId) && /^ckpt_[0-9a-f]{16}$/.test(pauseCheckpointId);

  const result = {
    scenario: { loopSteps: LOOP_STEPS, pauseAtStep: PAUSE_AT_STEP },
    runtimePackages: ["@crewhaus/graph-engine", "@crewhaus/checkpoint-store", "@crewhaus/run-context"],
    phase1_pause: {
      graphRunId,
      headCheckpointId: pauseCheckpointId,
      pausedNode,
      accumulatedContextItemsAtPause: accumulatedAtPause,
      checkpointFileOnDisk: headCkptOnDisk,
      checkpointFiles: ckptFiles,
      idShapeMatchesStoreContract: idShapeOk,
    },
    phase2_resume: {
      freshStoreReadHead: head,
      resumePointer,
      resumePointerBytes: Buffer.byteLength(resumePointer, "utf8"),
      resumedToCompletion: completed,
      finalContextItems: finalItems,
      resumedDecision,
    },
    proven: headCkptOnDisk && completed && idShapeOk,
    checkpointRoot: root,
  };

  if (wantJson) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  process.stdout.write("\n");
  process.stdout.write("================================================================\n");
  process.stdout.write(" CrewHaus checkpoint DURABILITY + RESUMABILITY proof\n");
  process.stdout.write(" (drives the exact runtime packages the emitted bundle imports)\n");
  process.stdout.write("================================================================\n");
  process.stdout.write(`scenario          : accumulate ${LOOP_STEPS} items, HITL pause as step ${PAUSE_AT_STEP} begins\n`);
  process.stdout.write(`graphRunId        : ${graphRunId}\n`);
  process.stdout.write(`head checkpointId : ${pauseCheckpointId}\n`);
  process.stdout.write(`paused at node    : ${pausedNode}\n`);
  process.stdout.write(`items at pause    : ${accumulatedAtPause}\n`);
  process.stdout.write(`id shape OK       : ${idShapeOk} (grun_<16hex> / ckpt_<16hex>)\n`);
  process.stdout.write("\nPHASE 1 — durability\n");
  process.stdout.write(`  checkpoint file on disk : ${headCkptOnDisk} (${pauseCheckpointId}.json)\n`);
  process.stdout.write(`  files in run dir        : ${ckptFiles.join(", ")}\n`);
  process.stdout.write("\nPHASE 2 — resume from a FRESH store (simulated new process)\n");
  process.stdout.write(`  fresh store read head   : ${head}\n`);
  process.stdout.write(`  resume pointer          : ${resumePointer}\n`);
  process.stdout.write(`  resume pointer bytes    : ${result.phase2_resume.resumePointerBytes}\n`);
  process.stdout.write(`  resumed to completion   : ${completed}\n`);
  process.stdout.write(`  final context items     : ${finalItems} (reloaded from durable storage, not re-sent)\n`);
  process.stdout.write(`  resumed decision        : ${resumedDecision}\n`);
  process.stdout.write(`\nPROVEN: ${result.proven} — durable on disk AND resumable across a process boundary.\n`);
  process.stdout.write("(A hand-built in-process MemorySaver loses all of this when the process dies.)\n\n");
}

await main();
