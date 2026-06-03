#!/usr/bin/env bun
/**
 * Workload (A) — NATIVE, HAND-BUILT LangGraph RAG pipeline.
 *
 * This is the labour the CrewHaus compiler avoids. The equivalent CrewHaus
 * artifact is `demos/starters/rag/crewhaus.yaml` (56 authored lines) which
 * emits `demos/starters/rag/dist/agent.ts` (83 lines) that simply *imports*
 * `@crewhaus/pipeline-engine`, `@crewhaus/chunker`, `@crewhaus/embedder`,
 * `@crewhaus/vector-store`, `@crewhaus/tool-retrieve` and `@crewhaus/runtime-core`
 * — the orchestration lives in a shared runtime-core, it is not inlined.
 *
 * Here we inline ALL of it by hand, the way a real LangGraph engineer must:
 *   - a fixed-size chunker (matches the spec's chunkStrategy: fixed / size 400)
 *   - a deterministic embedder (so the benchmark is reproducible offline)
 *   - an in-memory vector store with cosine similarity + top-k retrieval
 *   - an explicit LangGraph StateGraph: state schema (Annotation.Root),
 *     an indexing node, a retrieval node, and a read/generate node
 *   - the read node calls a real model when credentials are present, and
 *     falls back to an extractive answer (still grounded in retrieved chunks)
 *     when they are not, so the graph is runnable either way.
 *
 * Run:
 *   bun benchmarks/langgraph-vs-crewhaus/langgraph-rag.ts "what target shapes exist?"
 */

import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { callModel, type ChatMessage } from "./shared/live-model.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Corpus. Mirrors the documents embedded in starters/rag/crewhaus.yaml so the
// two implementations index the same knowledge and are comparable.
// ─────────────────────────────────────────────────────────────────────────────
type Doc = { id: string; text: string };

const DOCUMENTS: Doc[] = [
  {
    id: "target-shapes",
    text:
      "CrewHaus Factory supports multiple target harness shapes: " +
      "cli (single-agent REPL), workflow (sequential steps), " +
      "channel (long-running daemon for Slack and other channels), " +
      "graph (stateful node/edge runtime with HITL pauses), " +
      "managed (multi-tenant gateway with audit logs and budgets), " +
      "and pipeline (component-DAG runtime for RAG / retrieval). " +
      "Additional shapes planned: eval, res, voice, brow, batch.",
  },
  {
    id: "section-18",
    text:
      "Section 18 lands the production safety floor: sandbox (docker " +
      "backend with image allowlist, network=none default, read-only " +
      "root, /tmp tmpfs), tool-code-execution (Python, JavaScript, " +
      "Shell tools that require a sandbox), and prompt-injection " +
      "detector (regex + structural + optional LLM tier hooked into " +
      "runtime-core's post-tool path).",
  },
  {
    id: "section-19",
    text:
      "Section 19 lands the GRPH target shape: checkpoint-store " +
      "(file-backed JSONL), graph-engine (builder + interpreter with " +
      "HITL pauses), branch-history (branchAt + diff), durable- " +
      "execution (idempotency keys), and target-graph codegen.",
  },
  {
    id: "section-20",
    text:
      "Section 20 lands the MGD target shape and governance: " +
      "gateway-protocol (JSON-RPC v1), tenancy (per-tenant storage " +
      "rebase via AsyncLocalStorage), audit-log (hash-chained JSONL), " +
      "policy-engine (sideEffect classification), gateway-server " +
      "(Bun.serve with HS256 JWT), and target-managed codegen.",
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Hand-rolled indexing primitives. CrewHaus gives you these as `@crewhaus/chunker`,
// `@crewhaus/embedder` and `@crewhaus/vector-store`; LangGraph does not, so an
// engineer writes them (or wires a third dependency + a real DB) by hand.
// ─────────────────────────────────────────────────────────────────────────────
type Chunk = { id: string; docId: string; text: string };

/** Fixed-size character chunker. Matches spec chunkSize: 400, overlap: 0. */
function chunkDocument(doc: Doc, size: number, overlap: number): Chunk[] {
  const out: Chunk[] = [];
  const step = Math.max(1, size - overlap);
  let cursor = 0;
  let part = 0;
  while (cursor < doc.text.length) {
    const slice = doc.text.slice(cursor, cursor + size);
    out.push({ id: `${doc.id}#${part}`, docId: doc.id, text: slice });
    cursor += step;
    part += 1;
  }
  if (out.length === 0) out.push({ id: `${doc.id}#0`, docId: doc.id, text: doc.text });
  return out;
}

/**
 * Deterministic hashing embedder. Produces a fixed-dimension bag-of-tokens
 * vector so retrieval is reproducible without network or a model. This stands
 * in for `@crewhaus/embedder` configured with `model: mock/det` in the spec.
 */
const EMBED_DIM = 256;

function embed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 2166136261 >>> 0; // FNV-1a
    for (let i = 0; i < tok.length; i += 1) {
      h ^= tok.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    vec[h % EMBED_DIM] += 1;
  }
  // L2 normalise so cosine similarity is a plain dot product.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i += 1) vec[i] = (vec[i] as number) / norm;
  return vec;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

/** In-memory vector store with top-k cosine retrieval. */
type StoredVector = { chunk: Chunk; vector: number[] };

class InMemoryVectorStore {
  private readonly rows: StoredVector[] = [];
  upsert(chunk: Chunk, vector: number[]): void {
    this.rows.push({ chunk, vector });
  }
  count(): number {
    return this.rows.length;
  }
  search(queryVec: number[], k: number): Array<{ chunk: Chunk; score: number }> {
    return this.rows
      .map((r) => ({ chunk: r.chunk, score: cosine(queryVec, r.vector) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, k);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LangGraph state schema. Every field threaded between nodes must be declared
// here with a reducer; this is the explicit "state management" LOC the metric
// counts. CrewHaus infers this from the spec's `retrieve:` + `indexing:` blocks.
// ─────────────────────────────────────────────────────────────────────────────
const RagState = Annotation.Root({
  question: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  indexedCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  retrieved: Annotation<Array<{ chunk: Chunk; score: number }>>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  answer: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
});

type RagStateT = typeof RagState.State;

// A single store instance shared across node invocations within a run.
const store = new InMemoryVectorStore();
const DEFAULT_K = 4;

const RAG_SYSTEM_PROMPT =
  "You are a RAG-grounded assistant. Answer in 2-3 sentences citing the " +
  "retrieved chunks by [N] reference number. If the retrieved chunks don't " +
  'cover the question, say "I can only answer questions about the indexed ' +
  'docs" — do NOT improvise from outside the retrieval results.';

// ─── Node 1: indexing ────────────────────────────────────────────────────────
async function indexNode(_state: RagStateT): Promise<Partial<RagStateT>> {
  const chunks = DOCUMENTS.flatMap((d) => chunkDocument(d, 400, 0));
  for (const c of chunks) {
    store.upsert(c, embed(c.text));
  }
  process.stderr.write(`[langgraph-rag] indexed ${store.count()} chunks\n`);
  return { indexedCount: store.count() };
}

// ─── Node 2: retrieval ───────────────────────────────────────────────────────
async function retrieveNode(state: RagStateT): Promise<Partial<RagStateT>> {
  const queryVec = embed(state.question);
  const hits = store.search(queryVec, DEFAULT_K);
  process.stderr.write(
    `[langgraph-rag] retrieved ${hits.length} chunks for query: ${JSON.stringify(state.question)}\n`,
  );
  return { retrieved: hits };
}

// ─── Node 3: read / generate ─────────────────────────────────────────────────
async function generateNode(state: RagStateT): Promise<Partial<RagStateT>> {
  const context = state.retrieved
    .map((h, i) => `[${i + 1}] (${h.chunk.docId}, score=${h.score.toFixed(3)}) ${h.chunk.text}`)
    .join("\n");

  const messages: ChatMessage[] = [
    {
      role: "user",
      content:
        `Question: ${state.question}\n\n` +
        `Retrieved context:\n${context}\n\n` +
        "Answer using ONLY the retrieved context and cite [N].",
    },
  ];

  const result = await callModel({ system: RAG_SYSTEM_PROMPT, messages, maxTokens: 512 });

  if (result.ok) {
    return { answer: result.text };
  }

  // Offline fallback: extractive answer grounded in the top retrieved chunk so
  // the graph remains runnable and demonstrably retrieval-grounded with no key.
  const top = state.retrieved[0];
  const fallback = top
    ? `[1] ${top.chunk.text} (offline extractive answer — live model unavailable: ${result.reason})`
    : "I can only answer questions about the indexed docs.";
  return { answer: fallback };
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph wiring. Explicit edges: START → index → retrieve → generate → END.
// ─────────────────────────────────────────────────────────────────────────────
export function buildRagGraph() {
  return new StateGraph(RagState)
    .addNode("index", indexNode)
    .addNode("retrieve", retrieveNode)
    .addNode("generate", generateNode)
    .addEdge(START, "index")
    .addEdge("index", "retrieve")
    .addEdge("retrieve", "generate")
    .addEdge("generate", END)
    .compile();
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const question = process.argv.slice(2).join(" ").trim() || "What target harness shapes does CrewHaus Factory support?";
  const graph = buildRagGraph();
  const startedAt = Date.now();
  const final = await graph.invoke({ question });
  const elapsedMs = Date.now() - startedAt;

  process.stdout.write("\n=== HAND-BUILT LANGGRAPH RAG ===\n");
  process.stdout.write(`question : ${question}\n`);
  process.stdout.write(`indexed  : ${final.indexedCount} chunks\n`);
  process.stdout.write(
    `top hits : ${final.retrieved.map((h) => `${h.chunk.id}(${h.score.toFixed(3)})`).join(", ")}\n`,
  );
  process.stdout.write(`answer   :\n${final.answer}\n`);
  process.stdout.write(`elapsed  : ${elapsedMs} ms\n`);
}

if (import.meta.main) {
  await main();
}
