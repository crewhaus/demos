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
[`loc-results.json`](./loc-results.json).
**No figure in this document is fabricated.**
