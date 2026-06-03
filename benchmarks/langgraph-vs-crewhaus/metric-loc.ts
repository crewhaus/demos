#!/usr/bin/env bun
/**
 * METRIC 1 — boilerplate / lines of code (granular).
 *
 * Reports, for each workload, FOUR numbers plus the import line(s):
 *   (i)   hand-written native LangGraph LOC, broken down by category
 *         (state schema, node definitions, conditional edges, checkpoint
 *          saver wiring) — this is the labour the compiler avoids;
 *   (ii)  CrewHaus AUTHORED spec LOC (the crewhaus.yaml the engineer writes);
 *   (iii) CrewHaus EMITTED bundle LOC (dist/agent.ts produced by codegen);
 *   (iv)  the runtime-core LOC the emitted bundle IMPORTS rather than inlining
 *         (graph-engine + checkpoint-store) — i.e. why the bundle is thin.
 *
 * Plus: the single-line `import { ... } from "@crewhaus/..."` statements in the
 * emitted bundle that pull orchestration from the shared runtime-core.
 *
 * All counts use the granular code-line counter in shared/loc.ts (blank lines
 * and pure comments excluded). Run with --json for machine output.
 */

import { countFile, countRegion, grepLines } from "./shared/loc.ts";

const REPO = new URL("../../", import.meta.url).pathname; // demos/
const FACTORY = new URL("../../../factory/", import.meta.url).pathname; // factory/

// Hand-built LangGraph sources.
const LG_RAG = `${REPO}benchmarks/langgraph-vs-crewhaus/langgraph-rag.ts`;
const LG_GRAPH = `${REPO}benchmarks/langgraph-vs-crewhaus/langgraph-stateful-graph.ts`;
const LG_SHARED = `${REPO}benchmarks/langgraph-vs-crewhaus/shared/live-model.ts`;

// CrewHaus authored specs + emitted bundles.
const CH_RAG_SPEC = `${REPO}starters/rag/crewhaus.yaml`;
const CH_RAG_BUNDLE = `${REPO}starters/rag/dist/agent.ts`;
const CH_GRAPH_SPEC = `${REPO}starters/graph/crewhaus.yaml`;
const CH_GRAPH_BUNDLE = `${REPO}starters/graph/dist/agent.ts`;

// Shared runtime-core the bundle imports rather than inlining.
const RC_GRAPH_ENGINE = `${FACTORY}packages/graph-engine/src/index.ts`;
const RC_CHECKPOINT = `${FACTORY}packages/checkpoint-store/src/index.ts`;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function num(n: number, w = 6): string {
  return String(n).padStart(w);
}

function main(): void {
  const wantJson = process.argv.includes("--json");

  // ── Granular hand-built breakdown for the STATEFUL GRAPH (the workload with
  // the four named categories). Regions are delimited by @metric: markers.
  const stateSchema = countRegion(LG_GRAPH, "@metric:state-schema:start", "@metric:state-schema:end");
  const nodeDefs = countRegion(LG_GRAPH, "@metric:node-defs:start", "@metric:node-defs:end");
  const condEdges = countRegion(LG_GRAPH, "@metric:conditional-edges:start", "@metric:conditional-edges:end");
  const ckptWiring = countRegion(LG_GRAPH, "@metric:checkpoint-wiring:start", "@metric:checkpoint-wiring:end");

  const lgGraphTotal = countFile(LG_GRAPH);
  const lgRagTotal = countFile(LG_RAG);
  const lgSharedTotal = countFile(LG_SHARED);

  const chRagSpec = countFile(CH_RAG_SPEC);
  const chRagBundle = countFile(CH_RAG_BUNDLE);
  const chGraphSpec = countFile(CH_GRAPH_SPEC);
  const chGraphBundle = countFile(CH_GRAPH_BUNDLE);

  const rcGraphEngine = countFile(RC_GRAPH_ENGINE);
  const rcCheckpoint = countFile(RC_CHECKPOINT);

  // The import lines that make the emitted bundle thin (orchestration imported,
  // not inlined). Pull every `@crewhaus/...` import from each bundle.
  const ragImports = grepLines(CH_RAG_BUNDLE, '@crewhaus/');
  const graphImports = grepLines(CH_GRAPH_BUNDLE, '@crewhaus/');

  if (wantJson) {
    process.stdout.write(
      JSON.stringify(
        {
          handBuilt: {
            statefulGraph: {
              total: lgGraphTotal,
              breakdown: {
                stateSchema,
                nodeDefinitions: nodeDefs,
                conditionalEdges: condEdges,
                checkpointSaverWiring: ckptWiring,
              },
            },
            ragPipeline: { total: lgRagTotal },
            sharedLiveModel: { total: lgSharedTotal },
          },
          crewhaus: {
            rag: { authoredSpec: chRagSpec, emittedBundle: chRagBundle },
            graph: { authoredSpec: chGraphSpec, emittedBundle: chGraphBundle },
            runtimeCoreImportedNotInlined: {
              graphEngine: rcGraphEngine,
              checkpointStore: rcCheckpoint,
              total: rcGraphEngine.code + rcCheckpoint.code,
            },
          },
          emittedBundleImports: { rag: ragImports, graph: graphImports },
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  process.stdout.write("\n");
  process.stdout.write("================================================================\n");
  process.stdout.write(" METRIC 1 — BOILERPLATE / LINES OF CODE (granular)\n");
  process.stdout.write(" (code = non-blank, non-comment lines; raw = physical lines)\n");
  process.stdout.write("================================================================\n\n");

  process.stdout.write("STATEFUL GRAPH workload\n");
  process.stdout.write("-----------------------\n");
  process.stdout.write(`  hand-built native LangGraph, by category:        code   raw\n`);
  process.stdout.write(`    state schema (Annotation.Root + types)       : ${num(stateSchema.code, 5)} ${num(stateSchema.raw, 5)}\n`);
  process.stdout.write(`    node definitions (plan/work/reflect/finalize): ${num(nodeDefs.code, 5)} ${num(nodeDefs.raw, 5)}\n`);
  process.stdout.write(`    conditional edges (router fn)                : ${num(condEdges.code, 5)} ${num(condEdges.raw, 5)}\n`);
  process.stdout.write(`    checkpoint saver wiring (build + compile)    : ${num(ckptWiring.code, 5)} ${num(ckptWiring.raw, 5)}\n`);
  const handCoreSubtotal =
    stateSchema.code + nodeDefs.code + condEdges.code + ckptWiring.code;
  process.stdout.write(`    --------------------------------------------- ----- -----\n`);
  process.stdout.write(`    orchestration subtotal (the 4 named parts)   : ${num(handCoreSubtotal, 5)}\n`);
  process.stdout.write(`    whole file (incl. prompts/entrypoint/io)     : ${num(lgGraphTotal.code, 5)} ${num(lgGraphTotal.raw, 5)}\n\n`);

  process.stdout.write(`  CrewHaus FOUR numbers:\n`);
  process.stdout.write(`    (ii)  authored spec   crewhaus.yaml            : ${num(chGraphSpec.code, 5)} ${num(chGraphSpec.raw, 5)}\n`);
  process.stdout.write(`    (iii) emitted bundle  dist/agent.ts           : ${num(chGraphBundle.code, 5)} ${num(chGraphBundle.raw, 5)}\n`);
  process.stdout.write(`    (iv)  runtime-core IMPORTED (not inlined):\n`);
  process.stdout.write(`            graph-engine/src/index.ts              : ${num(rcGraphEngine.code, 5)} ${num(rcGraphEngine.raw, 5)}\n`);
  process.stdout.write(`            checkpoint-store/src/index.ts          : ${num(rcCheckpoint.code, 5)} ${num(rcCheckpoint.raw, 5)}\n`);
  process.stdout.write(`            = shared core total                    : ${num(rcGraphEngine.code + rcCheckpoint.code, 5)}\n\n`);

  process.stdout.write("  emitted-bundle import line(s) that keep it thin:\n");
  for (const l of graphImports) process.stdout.write(`    ${l}\n`);
  process.stdout.write("\n");

  process.stdout.write("RAG PIPELINE workload\n");
  process.stdout.write("---------------------\n");
  process.stdout.write(`  (i)   hand-built native LangGraph langgraph-rag.ts : ${num(lgRagTotal.code, 5)} ${num(lgRagTotal.raw, 5)}\n`);
  process.stdout.write(`  (ii)  authored spec   crewhaus.yaml                : ${num(chRagSpec.code, 5)} ${num(chRagSpec.raw, 5)}\n`);
  process.stdout.write(`  (iii) emitted bundle  dist/agent.ts                : ${num(chRagBundle.code, 5)} ${num(chRagBundle.raw, 5)}\n`);
  process.stdout.write("  emitted-bundle import line(s) that keep it thin:\n");
  for (const l of ragImports) process.stdout.write(`    ${l}\n`);
  process.stdout.write("\n");

  process.stdout.write("SHARED hand-built helper (live-model.ts, used by both): " + `${lgSharedTotal.code} code / ${lgSharedTotal.raw} raw\n`);

  // Ratios that make the thesis concrete.
  process.stdout.write("\nHEADLINE RATIOS\n---------------\n");
  process.stdout.write(
    `  graph: authored spec ${chGraphSpec.code} lines vs hand-built orchestration ${handCoreSubtotal} lines ` +
      `→ ${(handCoreSubtotal / chGraphSpec.code).toFixed(1)}x more code by hand for the 4 named parts alone.\n`,
  );
  const handTotalGraph = lgGraphTotal.code; // shared helper excluded (it is the model client both reuse)
  process.stdout.write(
    `  graph: authored spec ${chGraphSpec.code} vs whole hand-built file ${handTotalGraph} ` +
      `→ ${(handTotalGraph / chGraphSpec.code).toFixed(1)}x.\n`,
  );
  process.stdout.write(
    `  graph: hand-built orchestration ${handCoreSubtotal} lines re-implements what the bundle gets ` +
      `for one import each from ${rcGraphEngine.code + rcCheckpoint.code} lines of shared, tested runtime-core.\n`,
  );
  process.stdout.write(
    `  rag:   authored spec ${chRagSpec.code} vs hand-built ${lgRagTotal.code} → ${(lgRagTotal.code / chRagSpec.code).toFixed(1)}x.\n`,
  );
  process.stdout.write("\n");
}

main();
