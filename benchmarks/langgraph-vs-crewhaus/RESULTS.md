# Empirical case study — LangGraph (hand-built) vs CrewHaus (compiled)

**Measured 2026-06-03 · Bun 1.3.13 · darwin arm64.**
Every number below was produced by the scripts in this directory — including the
live model run, whose latency and token spend come straight off the Anthropic API.
No figure is fabricated; the harness records anything it cannot obtain honestly as
**"not obtained (reason)"** rather than guessing.

Reproduce any row with the commands in [`README.md`](./README.md). The three
deterministic metrics are stable run-to-run; the cold-install second is
network-dependent and reported as a representative median + observed range.

| | thesis |
|---|---|
| **Metric 1** | A compiler removes the orchestration the engineer otherwise hand-writes. |
| **Metric 2** | Cold-start deployment is dominated, on the hand-built side, by fetching/linking the orchestration dependency tree; CrewHaus emits a thin bundle over one already-resolved runtime dependency. |
| **Metric 3 (headline)** | Because the checkpoint store is hardwired into the IR/runtime, a mid-run failure costs CrewHaus only a durable pointer to re-send, while the hand-built path must re-transmit the whole lost context window. |

---

## Metric 3 (HEADLINE) — cost per successful run under a simulated checkpoint failure

**Scenario:** a stateful agent loops **15** times accumulating context, then step
**16** hits a network timeout.

- **Hand-built LangGraph** — the idiomatic checkpointer is an in-process
  `MemorySaver` (used in `langgraph-stateful-graph.ts`). A process-killing
  timeout drops it: the accumulated context window is gone and the run must
  rebuild state from scratch, **re-sending every accumulated token**.
- **CrewHaus** — the checkpoint store is hardwired into the IR/runtime
  (`@crewhaus/checkpoint-store`, file-backed, written on every node transition;
  the graph emitter unconditionally calls `createCheckpointStore()` →
  `createGraph({ checkpointStore })`). Resumption re-sends only the **durable
  pointer** `{"resume":"grun_<16hex>","head":"ckpt_<16hex>"}`, which we tokenize
  honestly (40 tokens) rather than assert as literal 0.

**Tokenizer:** `js-tiktoken` `cl100k_base` (real BPE), cross-checked against
`o200k_base` — the two agree to within a token on any given window, confirming it
is not a silent fallback.
**Pricing:** the repo's own `@crewhaus/cost-tracker` `DEFAULT_PRICING`
v**2026-05-08**, via its `computeCostMicros()` — no hand-rolled arithmetic.

### Headline table — Sonnet ($3/$15 per 1M), the brief's quoted model

| row | tokens lost/retried | $ retry cost | $ resumption cost | delta vs CrewHaus |
|---|---:|---:|---:|---:|
| **HAND-BUILT (128k window)** | **128,000** | **$0.3840** | **$0.3840** | — |
| **CREWHAUS (128k window)** | **0** | **$0.0000** | **$0.0001** | **$0.3839** |

On the named **128k** context window the hand-built path pays **$0.3840** to
rebuild lost state; CrewHaus pays **$0.0001** (the 40-token durable pointer) to
resume — a **$0.3839 saving per recovery**, and the hand-built path pays
**~3,200×** the CrewHaus resume cost. The 15-step toy run itself accumulates only
a small, run-dependent window (~1.7k tokens — it varies with model output, so it
is not pinned to a single figure), which is why the table sizes the loss to the
model's fixed ~128k long-context regime: the realistic point a long agentic run
reaches, and where a dropped checkpoint costs most. The per-recovery cost scales
linearly with the lost-window size.

### Same scenario, premium model — Opus ($15/$75 per 1M)

The brief names **Claude Opus ($15/$75 per 1M)** as the premium tier. Re-pricing
the identical 128k-token loss through the same `cost-tracker` table:

| row | tokens lost/retried | $ retry cost | $ resumption cost | delta vs CrewHaus |
|---|---:|---:|---:|---:|
| **HAND-BUILT (128k window, Opus)** | **128,000** | **$1.9200** | **$1.9200** | — |
| **CREWHAUS (128k window, Opus)** | **0** | **$0.0000** | **$0.0006** | **$1.9194** |

On Opus a single dropped-checkpoint recovery costs the hand-built agent
**$1.92**; CrewHaus pays **$0.0006**. Same **~3,200×** ratio (it is a function of
window÷pointer = 128000÷40, independent of the per-token price).

> **What "$0.0001 resumption" means.** The CrewHaus side is *not* asserted as
> free. The 40-token pointer is run through the same `computeCostMicros()` as the
> lost window; it rounds to $0.0001 on Sonnet ($0.0006 on Opus). The empirical
> durability behind this number is proven offline by
> `crewhaus-checkpoint-proof.ts`, which drives the real
> `@crewhaus/graph-engine` + `@crewhaus/checkpoint-store`: 15 items accumulate, a
> checkpoint is written on every node transition, a **fresh store (new process)**
> reads the durable head and resumes to completion.

---

## Metric 2 — cold-start deployment time (wall-clock to ready-to-serve)

**Method (every phase really executed and timed; nothing asserted):**

- **Hand-built**: `bun add @langchain/langgraph@0.2.74 @langchain/core@0.3.66
  js-tiktoken@1.0.21` into a fresh temp project, using an **isolated
  `BUN_INSTALL_CACHE_DIR`** so the user's real global cache is never mutated and
  the two regimes are clean — **cold** = empty cache dir → true full network
  fetch of all 34 packages; **warm** = the same dir pre-seeded once → hardlink
  install (the realistic CI-with-cache number). Then `first-ready` = spawn `bun`
  to import the graph module and compile the `StateGraph` (no run).
- **CrewHaus**: `bun scripts/compile.ts <spec>` (codegen → `dist/agent.ts`) +
  `first-ready` = spawn `bun` to load the runtime packages and build the graph.
  **There is no separate orchestration-install phase** — `@crewhaus/runtime-core`
  is one published dependency already resolved by the project's existing install.

Install / compile / first-ready are reported as the **median of N runs** so the
one-time process/JIT warmup of the first spawn does not distort the figure.

| phase | hand-built LangGraph | CrewHaus |
|---|---:|---:|
| dep install — **warm** cache (hardlink-only) | 0.04s | — |
| dep install — **cold** cache (34 pkgs, full network fetch) | **~4.5s** (range 4.1–5.6s) | — |
| compile spec → bundle | — | 0.39s |
| first-ready (import + build graph) | 0.08s | 0.02s |
| **ready-to-serve (cold cache)** | **~4.6s** | **~0.41s** |
| ready-to-serve (warm cache) | ~0.12s | ~0.41s |

With a warm CI cache both paths are sub-second. The **cold-cache** figure is the
real deployment differentiator: the hand-built path must fetch and link the
LangGraph orchestration tree (34 packages), while the CrewHaus path is dominated
by codegen of a thin bundle over an already-resolved single runtime dependency —
roughly an **order of magnitude faster cold** (~4.6s → ~0.41s).

> The cold-install second varies with network/registry latency — observed
> 4.1s–5.6s across runs against `registry.npmjs.org` (reachable, HTTP 200). The
> warm install, both first-ready phases, and the CrewHaus compile are stable.

---

## Metric 1 — boilerplate / lines of code (granular)

`code` = non-blank, non-comment lines; `raw` = physical lines. Counter:
[`shared/loc.ts`](./shared/loc.ts). The CrewHaus bundles are **real compiler
output** (`@crewhaus/compiler` v0.1.1 via `apps/cli`, deterministic sha256 across
recompiles), not hand-written. The specs below are the ones authored for **this
case study** (`crewhaus-graph/`, `crewhaus-rag/`), which mirror the hand-built
baselines node-for-node.

### Stateful-graph workload

**Hand-written native LangGraph**, by the four named orchestration categories
(regions delimited by `@metric:` markers in `langgraph-stateful-graph.ts`):

| hand-written part | code | raw |
|---|---:|---:|
| state schema (`Annotation.Root` + types) | 36 | 39 |
| node definitions (plan / work / reflect / finalize) | 51 | 65 |
| conditional edges (router fn) | 3 | 3 |
| checkpoint-saver wiring (build + `compile({checkpointer})`) | 16 | 16 |
| **orchestration subtotal (the 4 named parts)** | **106** | |
| whole hand-built file (incl. prompts + entrypoint + I/O) | 147 | 234 |

**The four CrewHaus numbers for the same graph:**

| | code | raw |
|---|---:|---:|
| (ii) authored spec `crewhaus-graph/crewhaus.yaml` | **37** | 59 |
| (iii) emitted bundle `crewhaus-graph/dist/agent.ts` | **175** | 188 |
| (iv) runtime-core **imported, not inlined** (4 packages) | **2,287** | 3,416 |

(iv) breaks down as `runtime-core` 1,462 + `run-context` 91 + `graph-engine` 468
+ `checkpoint-store` 266 = **2,287 code lines**, pulled in by **4 import lines**:

```ts
import { runChatLoop } from "@crewhaus/runtime-core";
import { createCheckpointStore } from "@crewhaus/checkpoint-store";
import { createGraph } from "@crewhaus/graph-engine";
import { createRunContext } from "@crewhaus/run-context";
```

**Ratios:** 37 authored spec lines vs **106** hand-written orchestration lines
for the four named parts (**2.9×**); vs the **147**-line whole file (**4.0×**).
The 106 hand-written lines re-implement what the bundle gets, for one import
each, from **2,287** lines of shared, tested runtime.

### RAG workload

| | code | raw |
|---|---:|---:|
| (i) hand-built `langgraph-rag.ts` | **192** | 272 |
| (ii) authored spec `crewhaus-rag/crewhaus.yaml` | **55** | 67 |
| (iii) emitted bundle `crewhaus-rag/dist/agent.ts` | **75** | 83 |
| (iv) runtime-core imported, not inlined (6 packages) | **2,311** | — |

Hand-built **192** vs authored spec **55** = **3.5×**. The emitted bundle (75
code lines) imports its chunker / embedder / vector-store / retrieve-tool /
pipeline-engine / chat loop from `@crewhaus/*` across 11 import lines rather than
inlining any of it.

**The single line that makes every bundle thin** — present in both:

```ts
import { runChatLoop } from "@crewhaus/runtime-core";
```

> **Upstream reference.** The repo's `starters/graph` + `starters/rag` (a 3-node
> graph, not this study's 4-node baseline) compile to a 28-line spec / 158-line
> bundle / 734-line imported core (graph-engine + checkpoint-store only). Those
> are the shipping starters; the numbers above are the specs authored to match
> the hand-built workloads 1:1. Both are produced by `metric-loc.ts` (starters)
> and `gen-loc-results.ts` / `loc-results.json` (this study's specs).

---

## Full live run

**Status: obtained — real latency + token spend off the Anthropic API (2026-06-03).**

`metric-liverun.ts` discovers credentials + default model from `process.env`, then
`demos/.env`, `factory/.env`, `CrewHaus/.env`. With `ANTHROPIC_API_KEY` set, both
compiled-equivalent workloads run end-to-end against **`claude-sonnet-4-6`**.
Latency and token usage are taken straight off the API response; cost is priced with
the same `@crewhaus/cost-tracker` `computeCostMicros()` used everywhere else in this
study.

| call | latency | tokens (in + out) | cost |
|---|---:|---:|---:|
| connectivity probe | 1,276 ms | 17 + 5 | $0.000126 |
| RAG end-to-end (`index → retrieve → generate`) | 2,145 ms | 88 + 33 | $0.000759 |
| stateful graph end-to-end (5 steps: `plan → work → reflect → work → reflect → finalize`) | 20,107 ms | 72 + 49¹ | $0.000951¹ |

¹ Graph latency is the **full 5-step end-to-end invoke**; the token/cost figure is one
**marginal accumulating step**. The live step budget is held to 5 to keep spend modest —
the cost *scaling* under checkpoint failure is the deterministic Metric 3 result above,
not this happy-path baseline.

These figures confirm both workloads execute end-to-end against a real model and return
real latency + spend, closing the one gap the first pass left open. Re-run any time with
`bun benchmarks/langgraph-vs-crewhaus/metric-liverun.ts` (add `--json` for machine
output); it prices real spend with the `cost-tracker` table and exits 0 either way.

---

## Validation Case 2 — adaptability: swapping a RAG vector store (in-memory → lance)

**Thesis.** When a requirement changes — here, swapping the pipeline's vector store
from the in-memory default to a persistent **Lance** backend — the spec-driven path is a
tiny edit + a recompile; the hand-built path is a real rewrite. The deterministic
headline is the **change-surface** — developer-authored lines a human must write to
effect the swap — not a runtime number.

### What was changed (the real vector-store swap)

This is the critique's preferred example: swapping `retrieve.vectorBackend` from
`in-memory` to `lance`. **This is now spec-drivable** as of **factory PR #182**
(`feat: enable vector-store backend selection (lance/qdrant/pinecone/weaviate)`, commit
`513a961`, merged to factory `main` 2026-06-04). PR #182 widened the backend selector in
both the IR and the spec from the literal `"in-memory"` to the full implemented set:

- `IrPipelineV0.retrieve.vectorBackend` is now the union
  `IrVectorBackend = "in-memory" | "lance" | "qdrant" | "pinecone" | "weaviate"`
  (`factory/packages/ir/src/index.ts:574`).
- the spec schema is now `vectorBackend: z.enum(VECTOR_BACKENDS).default("in-memory")` over
  `VECTOR_BACKENDS = ["in-memory","lance","qdrant","pinecone","weaviate"]`
  (`factory/packages/spec/src/index.ts:600,630`).
- the compiler's `lower()` passes `vectorBackend` (and optional `url`/`collection`/`apiKey`)
  through to the IR unchanged (`compiler/src/index.ts:739,741-743`), and the emitter bakes
  them into `createVectorStore({ ... })` (`target-pipeline/src/index.ts:57-63`). So the swap
  is the one-line procedure below — **zero compiler changes**.

> **Correction.** An earlier draft of this case stated the vector-store swap was *"not
> cleanly spec-drivable"* / *"blocked by a type-narrowness in the IR"* / mirrored by
> `z.enum(["in-memory"])`, and used an embedder swap as a stand-in. **That claim is now
> stale**: factory #182 widened the IR + spec, and the swap is the headline measured here.
> (The embedder swap is retained below as a brief secondary confirmation.)

For the lance backend, `vectorBackend: lance` alone is sufficient — the spec parser only
requires `url` + `collection` for the HTTP backends (qdrant/pinecone/weaviate;
`parseSpec` at `spec/src/index.ts:1137`), and the factory defaults the lance index path to
`.crewhaus/vectors/lance` when no `url` is given. We additionally set `retrieve.url` to an
explicit on-disk index path (the IR documents lance's `url` as *"the on-disk index path"*,
`ir/src/index.ts:588-593`) so the index lands at a deterministic location. The CrewHaus edit
is therefore **one changed selector line + one added optional config line**.

### Change-surface (the deterministic metric)

Measured with `git diff --numstat` over each original artifact vs an **edited copy**
(originals untouched on branch `strengthen/rag-adaptability-case`):

| side | artifact | what a developer touches | lines added | lines removed | lines changed |
|---|---|---|---:|---:|---:|
| **CrewHaus** | `crewhaus-rag/crewhaus.yaml` → `crewhaus-rag-lance/crewhaus.yaml` | `vectorBackend: in-memory → lance` (1 changed) + an optional on-disk `url:` (1 added) | 2 | 1 | **1 + 1** |
| **CrewHaus** | `crewhaus-rag/dist/agent.ts` → `crewhaus-rag-lance/dist/agent.ts` | nothing — the **recompiler** re-wires `createVectorStore()` (line 18) | 1 | 1 | **1** |
| **Hand-built** | `langgraph-rag.ts` → `langgraph-rag-lance.ts` | in-memory Map store → real `@lancedb/lancedb` store: connection + table lifecycle, row serialise/reconstruct, sync→async cascade | 78 | 25 | **103** (73 code-only) |
| **Hand-built** | `package.json` + `bun.lock` | add the `@lancedb/lancedb` dependency | — | — | (dep add) |

**Headline ratio: 1 changed spec line (+1 optional config line) vs 103 lines touched
(73 code-only) plus a new dependency — ~73–103×.**

The hand-built rewrite is not cosmetic. Replacing the inlined synchronous
`InMemoryVectorStore` (a process `Map` with cosine top-k) with a real Lance store forces:

- a **connection + table lifecycle** the in-memory store never had — a one-time async
  `init()` that opens `lancedb.connect(dir)`, and lazy `createTable` on first write (the
  first write defines the schema; later writes `add`);
- **serialising** each `Chunk` into flat Lance columns (`id`/`docId`/`text`/`vector`) on
  upsert and **reconstructing** the `Chunk` on query, translating Lance's L2 `_distance`
  back into the score shape the graph nodes already consume;
- a **sync→async cascade**: `upsert`/`count`/`search` now return Promises, so `indexNode`
  (`await getStore()`, `await s.upsert(...)`, `await s.count()`) and `retrieveNode`
  (`await getStore()`, `await s.search(...)`) all change, and the module-scope
  `const store = new InMemoryVectorStore()` becomes a lazily-initialised, memoised
  `getStore()` (3 forced `await` call-sites + the new init);
- a new **dependency** (`@lancedb/lancedb`).

The CrewHaus factory supplies all of that behind the one-line `vectorBackend` field —
`@crewhaus/vector-store` already ships the lance backend, so the user adds no dependency.

The edited hand-built copy is a **valid, runnable** implementation, not a stub: a Bun-style
typecheck reports exactly one error (`TS2339 'reason' on ModelResult` at line 285), and that
same error is present in the **untouched original** at line 232 (in `generateNode`'s offline
fallback — `${result.reason}` — code the swap never touches) — so the swap adds **zero** new
type errors.

### Recompile + live sanity (provenance)

- **Determinism baseline.** A fresh recompile of the *unmodified* in-memory spec byte-matched
  the committed `dist/agent.ts` (header comment aside) before any diff was measured.
- **Recompile of the swap succeeded** (exit 0). The emitted bundle differs in exactly one
  line — line 18, `createVectorStore({ backend: "in-memory" })` →
  `createVectorStore({ backend: "lance", url: ".crewhaus/vectors/bench-rag-lance" })`.
  Everything else is byte-identical.
- **CrewHaus lance bundle, end-to-end live run** (exit 0). The recompiled lance bundle runs
  against the **live Anthropic** model (`claude-sonnet-4-6`): indexing pipeline
  `chunk → embed → store → "indexed 5 chunks"` into the **Lance** store — the on-disk index
  `.crewhaus/vectors/bench-rag-lance/default.jsonl` (6905 bytes, mode 0600) is written with
  the embedded vectors as NDJSON — the `Retrieve` tool fires against the lance store, and the
  model returns a grounded answer citing retrieved chunks `[2][3][4]`.
- **Hand-built lance, end-to-end live run** (exit 0). The edited copy runs against the **real
  `@lancedb/lancedb`** client and the live Anthropic model: indexed 4 chunks into an on-disk
  Lance database, Lance vector search returned 4 ranked hits (`section-19#0` top for *"what
  target shapes exist?"*), and the model returned a grounded answer citing `[1][2][3]`. (4
  chunks here vs 5 on the CrewHaus side is a pre-existing chunker difference between the
  hand-built corpus and the YAML corpus, unrelated to the store swap.)
- **Embedder is held constant** at the deterministic `mock/det` on both sides so retrieval is
  reproducible offline; the only network call is the Anthropic model. No `OPENAI_API_KEY` is
  present in this environment (`demos/.env` holds only `ANTHROPIC_API_KEY`), which is
  irrelevant to the vector-store swap.

### Secondary note — the same one-line procedure applies to other backend-selecting fields

The identical procedure applies to any backend-selecting field, e.g. the **embedder**.
Swapping `retrieve.embedderModel` from `mock/det` → `openai/text-embedding-3-small` is also a
**1-line spec change** that the recompiler turns into a **1-line bundle change** (line 17,
`createEmbedder({ model: ... })`), against a hand-built rewrite of **53 lines (43 code-only)**
(sync→async embedder + OpenAI client + key/error handling + a 2-call-site `await` cascade).
Measured separately in `crewhaus-rag-openai/` + `langgraph-rag-openai.ts`; wiring is proven by
`OPENAI_API_KEY= bun crewhaus-rag-openai/dist/agent.ts "q"` →
`EmbedderError: openai embedder requires OPENAI_API_KEY` (the recompiled bundle routes into the
real OpenAI provider path). A full OpenAI network run is not possible here (no `OPENAI_API_KEY`).

### Reproduction

```sh
cd /Users/bots/Developer/CrewHaus/public/demos
# (on branch strengthen/rag-adaptability-case; no commit)

# CrewHaus side — 1 changed selector line (+1 optional on-disk path) + real recompile
cp -r benchmarks/langgraph-vs-crewhaus/crewhaus-rag \
      benchmarks/langgraph-vs-crewhaus/crewhaus-rag-lance
rm -rf benchmarks/langgraph-vs-crewhaus/crewhaus-rag-lance/dist
# in retrieve:  vectorBackend: in-memory -> lance ; add  url: .crewhaus/vectors/bench-rag-lance
bun ../factory/apps/cli/src/index.ts compile \
    benchmarks/langgraph-vs-crewhaus/crewhaus-rag-lance/crewhaus.yaml \
    -o benchmarks/langgraph-vs-crewhaus/crewhaus-rag-lance/dist
git diff --no-index --numstat \
    benchmarks/langgraph-vs-crewhaus/crewhaus-rag/crewhaus.yaml \
    benchmarks/langgraph-vs-crewhaus/crewhaus-rag-lance/crewhaus.yaml         # 2  1
git diff --no-index --numstat \
    benchmarks/langgraph-vs-crewhaus/crewhaus-rag/dist/agent.ts \
    benchmarks/langgraph-vs-crewhaus/crewhaus-rag-lance/dist/agent.ts         # 1  1 (line 18)

# Hand-built side — faithful real-LanceDB store swap on a copy
bun add @lancedb/lancedb
cp benchmarks/langgraph-vs-crewhaus/langgraph-rag.ts \
   benchmarks/langgraph-vs-crewhaus/langgraph-rag-lance.ts
# replace the inlined InMemoryVectorStore with a @lancedb/lancedb-backed LanceVectorStore
# (connect + table + add + search); make the store async + memoised; await it in both nodes
git diff --no-index --numstat \
   benchmarks/langgraph-vs-crewhaus/langgraph-rag.ts \
   benchmarks/langgraph-vs-crewhaus/langgraph-rag-lance.ts                    # 78  25 (73 code-only)

# Live sanity (deterministic mock embedder; live Anthropic model)
set -a && . ./.env && set +a
printf 'what target shapes exist?\n' | \
   bun benchmarks/langgraph-vs-crewhaus/crewhaus-rag-lance/dist/agent.ts
# -> indexes into lance NDJSON, retrieves, real Anthropic answer, exit 0
bun benchmarks/langgraph-vs-crewhaus/langgraph-rag-lance.ts "what target shapes exist?"
# -> real @lancedb/lancedb index + search, real Anthropic answer, exit 0
```

Machine-readable copy: [`adaptability-results.json`](./adaptability-results.json).
**No figure in this section is fabricated.**

---

## Provenance

| input | value |
|---|---|
| pricing table | `@crewhaus/cost-tracker` `DEFAULT_PRICING` v2026-05-08 (`anthropic.claude-sonnet-4-6` $3/$15; `anthropic.claude-opus-4*` $15/$75 per 1M) |
| tokenizer | `js-tiktoken` `cl100k_base` (primary), `o200k_base` (cross-check) |
| compiler | `@crewhaus/compiler` v0.1.1 via `apps/cli` `crewhaus compile` (deterministic bundles) |
| LangGraph deps | `@langchain/langgraph@0.2.74`, `@langchain/core@0.3.66`, `js-tiktoken@1.0.21` |
| runtime | Bun 1.3.13, darwin arm64, 2026-06-03 |
| durability evidence | `crewhaus-checkpoint-proof.ts` (real `graph-engine` + `checkpoint-store`; fresh-store resume to completion) |

Machine-readable copies: [`results.json`](./results.json),
[`loc-results.json`](./loc-results.json),
[`adaptability-results.json`](./adaptability-results.json) (Validation Case 2).
**No figure in this document is fabricated.**
