# LangGraph (hand-built) vs CrewHaus (compiled) — empirical case study

This directory holds the **native, hand-built LangGraph baseline** for a
published-whitepaper case study, plus the harness that measures it against the
equivalent CrewHaus compiled artifacts.

The thesis under test: *an agent compiler removes the orchestration labour an
engineer otherwise hand-writes, and — because it hardwires durable state into
the IR/runtime — it eliminates a class of failure cost that a hand-rolled
in-process checkpoint cannot.*

Everything here is measured. Where a number cannot be obtained honestly (the
live model run, absent credentials in this checkout) it is recorded as
**"not obtained (reason)"** and never fabricated.

---

## What is hand-built

Two workloads, written out manually and idiomatically in LangGraph (TypeScript,
Bun), the way a real engineer would — the orchestration is **inlined**, because
that is precisely the labour the compiler avoids:

| File | Workload |
|------|----------|
| `langgraph-rag.ts` | (A) standard RAG pipeline: hand-rolled fixed-size chunker, deterministic embedder, in-memory cosine vector store, and an explicit `StateGraph` with index → retrieve → read/generate nodes and edges. |
| `langgraph-stateful-graph.ts` | (B) moderately complex stateful graph: explicit `Annotation.Root` state schema with an **accumulating-context** reducer, four node defs (plan / work / reflect / finalize), a **conditional-edge** router that loops work↔reflect until a step budget, and a **`MemorySaver` checkpoint saver** wired through `compile({ checkpointer })`. Models a long-running loop over 15+ steps. |
| `shared/live-model.ts` | Credential discovery + a direct Anthropic Messages API call (no SDK). Returns real token usage; never throws — failures come back as `{ ok: false, reason }`. Used by both workloads' generate/finalize nodes. |
| `shared/loc.ts` | Granular LOC counter (blank + comment lines excluded). |

Both workloads are runnable on their own and fall back to a deterministic
offline path (still grounded in retrieved/accumulated state) when no model
credentials are present, so the graphs execute end-to-end regardless.

```bash
bun benchmarks/langgraph-vs-crewhaus/langgraph-rag.ts "what target shapes exist?"
bun benchmarks/langgraph-vs-crewhaus/langgraph-stateful-graph.ts --steps 15
```

### The CrewHaus side of the comparison

The compiled equivalents already live in this repo and are **not** modified:

- RAG: `starters/rag/crewhaus.yaml` (authored spec) → `starters/rag/dist/agent.ts` (emitted bundle)
- Graph: `starters/graph/crewhaus.yaml` (authored spec) → `starters/graph/dist/agent.ts` (emitted bundle)

The emitted bundle is **thin** because its orchestration is imported from a
shared runtime-core, not inlined — e.g. the graph bundle's entire durability +
interpreter layer is four import lines:

```ts
import { runChatLoop } from "@crewhaus/runtime-core";
import { createCheckpointStore } from "@crewhaus/checkpoint-store";
import { createGraph } from "@crewhaus/graph-engine";
import { createRunContext } from "@crewhaus/run-context";
```

---

## Running the metrics

```bash
# Everything, in order:
bun benchmarks/langgraph-vs-crewhaus/run-all.ts            # full (cold-install uses an isolated bun cache — the user's global cache is never touched)
bun benchmarks/langgraph-vs-crewhaus/run-all.ts --warm     # skip the cold-install measurement (faster)

# Individually (each accepts --json for machine output):
bun benchmarks/langgraph-vs-crewhaus/metric-loc.ts          # metric 1 — LOC (starters reference)
bun benchmarks/langgraph-vs-crewhaus/gen-loc-results.ts     # metric 1 — LOC for THIS study's authored specs → loc-results.json
bun benchmarks/langgraph-vs-crewhaus/metric-coldstart.ts    # metric 2 — cold-start (isolated cache; medians)
bun benchmarks/langgraph-vs-crewhaus/failure-scenario.ts    # metric 3 — checkpoint-failure cost (headline)
bun benchmarks/langgraph-vs-crewhaus/crewhaus-checkpoint-proof.ts   # durability proof (real graph-engine + checkpoint-store)
bun benchmarks/langgraph-vs-crewhaus/metric-liverun.ts      # full live run (records "not obtained" if no creds)
```

The publication-ready results live in [`RESULTS.md`](./RESULTS.md) (tables) and
[`results.json`](./results.json) (machine-readable).

Dependencies (added to the repo's `package.json`):
`@langchain/langgraph@0.2.74`, `@langchain/core@0.3.66`, `js-tiktoken@1.0.21`.

> Pin note: LangGraph `1.x` is pinned away from because its ESM subpath
> (`@langchain/core/singletons`) does not resolve cleanly under Bun's
> global-cache layout. `0.2.74` is the stable line most engineers are on and
> resolves cleanly. The hand-written orchestration is identical either way.

---

## Metric definitions + method

### Metric 1 — boilerplate / LOC (granular) — `metric-loc.ts`

Reports four numbers per workload plus the bundle's import line(s):
1. hand-written native LangGraph LOC, broken down by **state schema /
   node definitions / conditional edges / checkpoint-saver wiring** (regions
   delimited by `@metric:` markers in `langgraph-stateful-graph.ts`);
2. CrewHaus **authored spec** LOC (`crewhaus.yaml`);
3. CrewHaus **emitted bundle** LOC (`dist/agent.ts`);
4. the **runtime-core LOC the bundle imports rather than inlining**
   (`graph-engine` + `checkpoint-store`).

`code` = non-blank, non-comment lines; `raw` = physical lines. The counter
under-attributes comments to our own favoured side and counts every syntax line
on the hand-built side — the conservative direction for the thesis.

### Metric 2 — cold-start deployment time — `metric-coldstart.ts`

Wall-clock from cold to ready-to-serve, each phase really executed:
- **Hand-built**: `bun add` the LangGraph deps into a fresh temp project, using
  an **isolated `BUN_INSTALL_CACHE_DIR`** so the user's real global cache is never
  mutated. Measured cold-cache (empty dir → true full network fetch of all 34
  packages) *and* warm-cache (the same dir pre-seeded once → hardlink-only,
  the realistic CI number). Then spawn `bun` to import the graph module and
  compile the `StateGraph`.
- **CrewHaus**: `bun scripts/compile.ts <spec>` (codegen) + spawn `bun` to load
  the runtime-core and build the graph. No separate orchestration-install phase:
  the runtime-core is one published dependency resolved by the existing install.

Install / compile / first-ready are reported as the **median of N runs** to
exclude the one-time process/JIT warmup of the first spawn.

### Metric 3 (headline) — cost per run under a checkpoint failure — `failure-scenario.ts`

Scenario: agent loops **15** times accumulating context; step **16** hits a
network timeout.
- **Hand-built**: the in-process `MemorySaver` checkpoint is dropped by the
  crash; the accumulated context window is lost and must be rebuilt → cost =
  *(accumulated context tokens re-sent/re-derived) × real per-token price*.
- **CrewHaus**: the checkpoint store is file-backed and hardwired into the
  IR/runtime, so resumption re-sends only the durable pointer (`grun_<16hex>` +
  head `ckpt_<16hex>`) → near-zero extra tokens (the pointer is tokenized
  honestly rather than asserted as literal 0).

Token counts: real tokenizer (`js-tiktoken`, `cl100k_base`, with an `o200k_base`
cross-check). Dollar costs: the repo's **own** cost-tracker pricing table
(`@crewhaus/cost-tracker` `DEFAULT_PRICING`, version-stamped) via its
`computeCostMicros()` — no hand-rolled arithmetic. Two regimes are reported: the
**measured** accumulated window for this toy workload, and the named **128k**
context window (the headline row).

### Full live run — `metric-liverun.ts`

Executes both graphs end-to-end against a live model and reports real
successful-run latency + token spend, pricing the spend with the same
cost-tracker table. Credentials + default model are discovered from
`process.env`, then `demos/.env`, `factory/.env`, `CrewHaus/.env`. If absent or a
call fails, every figure is recorded as **"not obtained (reason)"** and the
deterministic metrics 1–3 stand on their own.

---

## Results recorded in this checkout (2026-06-03, Bun 1.3.13, darwin arm64)

Headline figures below; the full publication-ready tables (incl. the Opus
premium-model row) are in **[`RESULTS.md`](./RESULTS.md)** and
**[`results.json`](./results.json)**. Re-run to reproduce; the deterministic
metrics are stable run-to-run (the cold-install second is network-dependent).

### Metric 1 — LOC (this study's authored specs; code lines)

**Stateful graph** — hand-written native LangGraph orchestration, the four named
parts: state schema 36 / node defs 51 / conditional edges 3 / checkpoint wiring
16 = **106** code lines (whole file 147 / 234 raw). CrewHaus: authored spec
**37**, emitted bundle **175**, runtime-core **imported not inlined** =
**2,287** code (runtime-core 1,462 + run-context 91 + graph-engine 468 +
checkpoint-store 266) via **4 import lines**. Ratios: spec 37 vs orchestration
106 = **2.9×**; vs whole file 147 = **4.0×**.

**RAG** — hand-built **192** vs authored spec **55** = **3.5×**; emitted bundle
**75** (chunker / embedder / vector-store / retrieve / pipeline-engine / chat
loop all imported, 11 import lines).

The single line that keeps every bundle thin:
`import { runChatLoop } from "@crewhaus/runtime-core";`

> The shipping `starters/graph` (a 3-node graph, not this study's 4-node
> baseline) compiles to 28-line spec / 158-line bundle / 734-line imported core —
> produced by `metric-loc.ts`. The numbers above (the specs authored to match the
> hand-built workloads 1:1) come from `gen-loc-results.ts` → `loc-results.json`.

### Metric 2 — cold-start deployment time

| | hand-built LangGraph | CrewHaus |
|---|---:|---:|
| dep install (**warm** cache, hardlink) | 0.04s | — |
| dep install (**cold** cache, full fetch of 34 pkgs) | **~4.5s** (4.1–5.6s) | — |
| compile spec → bundle | — | 0.39s |
| first-ready (import + build graph) | 0.08s | 0.02s |
| **ready-to-serve (cold cache)** | **~4.6s** | **~0.41s** |
| ready-to-serve (warm cache) | ~0.12s | ~0.41s |

Warm CI cache: both sub-second. Cold cache is the differentiator — the
hand-built path fetches+links a 34-package orchestration tree (~4.6s); CrewHaus
is codegen over one already-resolved runtime dependency (~0.41s), roughly an
order of magnitude faster cold.

### Metric 3 (headline) — cost under checkpoint failure

Tokenizer `cl100k_base` (o200k cross-check); pricing `@crewhaus/cost-tracker`
v2026-05-08, `anthropic/claude-sonnet-4-6` = $3/$15 per 1M.

| row | tokens lost/retried | $ retry | $ resumption |
|---|---:|---:|---:|
| **HAND-BUILT (128k window)** | **128000** | **$0.3840** | **$0.3840** |
| **CREWHAUS (128k window)** | **0** | **$0.0000** | **$0.0001** |

The 15-step toy run accumulates only a small, run-dependent window (~1.7k tokens),
so the table uses the model's fixed ~128k long-context regime. Delta (128k window):
**$0.3839 saved per recovery**; hand-built pays **~3,200×** the CrewHaus resume cost. The CrewHaus resumption cost is the 40-token durable
pointer `{"resume":"grun_…","head":"ckpt_…"}`, not zero — measured, not asserted.
On the brief's named premium model **Opus ($15/$75)** the same loss is
**$1.9200** hand-built vs **$0.0006** CrewHaus (same 3,200× ratio) — see
`RESULTS.md`.

### Full live run

**Not obtained** in this checkout: no Anthropic credentials present
(`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are commented out in all of
`demos/.env`, `factory/.env`, `CrewHaus/.env`, and empty in `process.env`). The
request path is verified reachable and well-formed — with a key injected it
reaches `api.anthropic.com/v1/messages` and returns a real HTTP 401 for an
invalid key, confirming a valid key would yield real latency + usage. Set a
credential and re-run `metric-liverun.ts` to populate this row.
