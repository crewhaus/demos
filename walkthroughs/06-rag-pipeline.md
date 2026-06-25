---
test:
  spec: starters/rag/crewhaus.yaml
---

# Recipe 06 — RAG Pipeline

Build a retrieval-augmented agent that grounds every answer in an
indexed corpus. The pipeline target chunks your documents, embeds the
chunks, stores the vectors in a backend, and injects a `Retrieve` tool
that the agent calls before answering — so the model can cite specific
chunks by `[N]` and refuse questions outside the corpus.

> **When NOT to use this — RAG isn't always the answer.** "RAG" is the
> reflex when "documents" appear in the problem statement, but
> pipeline-first only beats agent-first when retrieval quality *is* the
> engineering challenge. If the bottleneck is elsewhere, a different
> shape wins.
> - If the agent needs to **explore documents autonomously** over a
>   goal (not a fixed corpus + lookup) → [Recipe 07 — Autonomous
>   Research](07-autonomous-research.md). Multi-step planning, not
>   retrieve-then-answer.
> - If you just want an **LLM to summarize one document** you already
>   have in hand → [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md)
>   (paste it in) or [Recipe 02 — Sequential
>   Workflow](02-sequential-workflow.md) (extract → summarize → format).
>   No vector store, no Retrieve tool.
> - If the corpus is **small enough to fit in the system prompt** →
>   inline it in `agent.instructions`; skip the embedding/index step
>   entirely.

You'd reach for `target: pipeline` when:

- The agent must answer **only** from a known set of documents.
- You want **citations** the user can click through.
- The corpus is too big (or too proprietary) to put in the system
  prompt.
- You want to swap the **embedder** or **vector store** without
  touching the agent prompt.

If you want fully autonomous, multi-step research over a goal (not a
fixed corpus), use [`research`](07-autonomous-research.md) instead.

<details>
<summary><strong>Architectural context</strong> — pipeline-first beats agent-first when the bottleneck is retrieval</summary>

Haystack and LlamaIndex are the field's strongest signals that **when
retrieval quality is the engineering challenge, you want a
pipeline-first harness, not an agent-first one**.
Haystack's core design is "components connected by pipelines" —
routers, retrievers, generators, tools as swappable units — and
LlamaIndex is structured around data-centric workflows for the same
reason. The `pipeline` target lowers to `IrPipelineV0`, an explicit
DAG of `chunk → embed → store → retrieve → answer` steps, each
swappable: change the embedder from `mock/det` to `openai/text-embedding-3-small`
and only one IR node changes; change the vector store from `in-memory`
to `qdrant` and only one IR node changes. The agent's instructions
are unchanged.

This separation matters because "RAG quality" is rarely a model
problem and almost always a retrieval problem: chunk size, overlap,
ranker, top-k, citation faithfulness. The Pillar 2 optimizer's
`OPTIMIZABLE_PATHS` ([packages/spec-patch](https://github.com/crewhaus/factory/blob/main/packages/spec-patch))
includes `chunkOverlap` and `defaultK` for exactly this reason — when
eval grades RAG output, the optimizer should reach for retrieval
parameters before it touches prompts. Ragas is the field's most
mature RAG eval surface; pair this recipe with
[Recipe 12 — Eval Harness](12-eval-harness.md) and
[Recipe 34 — Building Custom Graders](34-building-custom-graders.md)
to wire Ragas-style faithfulness and answer-relevancy graders.

</details>

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- No external API keys needed for the example — `mock/det` and
  `in-memory` ship as defaults.

## The smallest spec

The bundled example [`starters/rag/crewhaus.yaml`](../starters/rag/crewhaus.yaml)
is one agent and four inline documents:

```yaml
name: hello-rag
target: pipeline
agent:
  model: claude-sonnet-4-6
  instructions: |
    For every question, call Retrieve first. Answer in 2-3 sentences
    citing chunks by [N]. If retrieved chunks don't cover the question,
    say "I can only answer questions about the indexed docs."
retrieve:
  embedderModel: mock/det
  vectorBackend: in-memory
  defaultK: 4
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Retrieve
indexing:
  chunkStrategy: fixed
  chunkSize: 400
  chunkOverlap: 0
  documents:
    - id: target-shapes
      text: |
        CrewHaus Factory supports multiple target harness shapes:
        cli, workflow, channel, graph, managed, pipeline, eval,
        research, voice, browser, batch, crew.
    - id: section-19
      text: |
        Section 19 lands the GRPH target shape: checkpoint-store,
        graph-engine (HITL pauses), branch-history, durable-execution.
```

The shape:

- **`agent:`** is the chat-loop spec — same fields as a CLI's agent
  block, plus the `Retrieve` tool that's auto-injected.
- **`retrieve:`** picks the embedder + vector backend and sets the
  default `k` for retrieval.
- **`indexing:`** describes how to chunk and what to index. The
  schema is strict: `documents:` is a required inline array of
  `{ id, text, metadata? }` — see "Corpora that live on disk" below
  for handling file-based corpora.
- **`permissions:`** must allow `Retrieve` if you want it to call
  without prompting (which is almost always what you want in a RAG
  pipeline).

Run it.

Standalone (from the harness directory):

```bash
cd starters/rag
bunx crewhaus compile crewhaus.yaml -o dist
bunx crewhaus run crewhaus.yaml      # or: bun dist/agent.ts
```

Or, working inside the demos checkout, from the repo root:

```bash
bun run compile starters/rag
bun run run starters/rag
```

Type "What target shapes does crewhaus support?". The agent will call
`Retrieve("target shapes")`, get the top-4 chunks, and answer with
inline `[1]`-style citations. Ask "what's the capital of France?" and
it will refuse — that chunk isn't in the corpus.

## How indexing works

Compile bakes the **documents** into the bundle; the chunk → embed →
store pipeline runs **once at process start**:

1. `bun run compile starters/rag` validates the spec and emits the
   bundle with `indexing.documents` embedded as a literal, alongside
   the embedder/vector-store boot code.
2. At process start, every document text is split via the
   `chunkStrategy`:
   - **`fixed`** — exact `chunkSize`-character windows with
     `chunkOverlap` overlap. Predictable.
   - **`semantic`** — sentence-boundary splitting (via
     `Intl.Segmenter`), packed into windows of `chunkSize` sentences.
     No model call — "semantic" here means sentence-aware, not
     embedding-driven.
   - **`markdown`** — split at heading boundaries (`#`, `##`); long
     sections sub-chunk via the `fixed` strategy. Best for docs
     corpora.
3. Each chunk is embedded with `embedderModel` and upserted into the
   vector store (you'll see `[pipeline] indexed N chunks` on stderr).
   The agent loop then serves `Retrieve` calls against that store.

Two consequences: editing `documents:` requires a recompile (the
corpus lives in the bundle), and a remote embedder is called at every
process start — for the inline-docs scale this target is built for,
that's a few hundred embeddings at boot.

## Embedder selection

`embedderModel` follows the same prefix grammar as `model:`:

| Prefix                                     | Backend                                  | When to use                                              |
| ------------------------------------------ | ---------------------------------------- | -------------------------------------------------------- |
| `mock/det`                                 | Deterministic 256-dim hash               | Tests / smokes. No API key needed.                       |
| `openai/text-embedding-3-small`            | OpenAI                                    | Default production choice; fast and cheap.               |
| `openai/text-embedding-3-large`            | OpenAI                                    | When recall matters more than cost.                      |
| `voyage/voyage-3`                          | Voyage AI                                | Strongest English embedding model as of writing.         |
| `cohere/embed-v3`                          | Cohere (OpenAI-compatible surface)        | If you already use Cohere for other workloads.            |
| `gemini/gemini-embedding-001`              | Google Generative Language API            | If your stack is already on Gemini keys.                  |
| `local/<model>@http://localhost:11434`     | Local Ollama/llama.cpp/etc.              | Air-gapped or cost-sensitive setups.                     |

Every provider speaks plain `fetch` — no SDK is loaded for any of
them, so swapping embedders never changes your dependency footprint.

API keys come from `.env` (`OPENAI_API_KEY`, `VOYAGE_API_KEY`,
`COHERE_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`). For local
backends no key is needed.

One URL-shape note: the embedder's `local/` form **requires** the
`@<base-url>` part (there's no Ollama default like chat model strings
have), but it tolerates the URL with or without the trailing `/v1` —
it normalizes before appending `/v1/embeddings`. Chat `local/` model
strings, by contrast, must include `/v1` in the URL.

## Vector store backends

`vectorBackend` picks the runtime store:

| Backend       | Persistence                                | Scale ceiling                                |
| ------------- | ------------------------------------------ | -------------------------------------------- |
| `in-memory`   | None (rebuilt at each process start)       | ~100K chunks; perfect for the docs-corpus case. |
| `lance`       | LanceDB on local disk                      | Millions of chunks, single-host.             |
| `qdrant`      | Remote Qdrant cluster                      | Multi-tenant, billions of vectors.           |
| `pinecone`    | Pinecone managed service                   | Multi-tenant, hosted.                        |
| `weaviate`    | Weaviate (self-hosted or cloud)            | Hybrid keyword + vector.                     |

Connection info lives in the spec's `retrieve:` block, not in
ad-hoc env vars: `url` is the service base URL (for `lance`, it
doubles as the on-disk index path), `collection` names the
collection/table, and `apiKey` takes a `$ENV_REF` so the secret
resolves from `process.env` at runtime instead of being baked into
the bundle:

```yaml
retrieve:
  embedderModel: openai/text-embedding-3-small
  vectorBackend: qdrant
  url: https://qdrant.internal:6333
  collection: docs
  apiKey: $QDRANT_API_KEY
```

The HTTP backends (`qdrant`, `pinecone`, `weaviate`) require `url` +
`collection` — the spec parser rejects a spec that selects one
without them, at compile time rather than at runtime. The `in-memory`
backend is the default because it has zero config; for anything
beyond ~100K chunks switch to `lance` or one of the hosted services.

## The `Retrieve` tool the model sees

```typescript
Retrieve({
  query: string,       // the natural-language question
  k?: number,          // overrides defaultK (max 50)
  filter?: object      // flat metadata key→value predicates
})
```

The result comes back as a numbered text list, one block per hit:

```
[1] id=target-shapes:0:0 doc=target-shapes score=0.8123
CrewHaus Factory supports multiple target harness shapes: ...

[2] id=section-19:0:0 doc=section-19 score=0.6310
Section 19 lands the GRPH target shape: ...
```

The `[N]` numbering is the citation handle — the model cites chunks
by their **position in the retrieval result** (`[1]`, `[2]`, ...),
which is exactly what the prompt below asks for.

The agent's system prompt is the only place that teaches "always cite"
behavior. The example's prompt is a working template:

```
For every question, call Retrieve first. Answer in 2-3 sentences
citing chunks by [N]. If retrieved chunks don't cover the question,
say "I can only answer questions about the indexed docs."
```

The two non-negotiables:

1. **"Call Retrieve first"** — so the model never answers from prior
   knowledge.
2. **"If chunks don't cover, refuse"** — so the model doesn't
   confabulate when retrieval returns weak matches.

## Tuning chunks

`chunkSize` and `chunkOverlap` are the two main knobs.

- **`chunkSize: 400`** is a reasonable default — small enough that
  retrieval is precise, large enough that the chunk carries useful
  context.
- **`chunkOverlap: 0`** is fine for `markdown` chunking (the heading
  boundary is already a natural break); for `fixed` strategy use
  `chunkOverlap: 50–100` so a query straddling a chunk boundary
  doesn't miss.
- **Empirically:** longer chunks (1000+) help when the chunks
  themselves contain self-contained explanations; shorter chunks
  (200) help when queries target specific facts.

Wire it to [Recipe 12 — Eval Harness](12-eval-harness.md) to A/B-test
chunk strategies — the eval target is the natural way to compare
retrieval-grounded accuracy across configurations.

## Corpora that live on disk

The pipeline schema is strict: there is no `documentsFromDir:` or
glob field — `indexing.documents` must be inline `{ id, text }`
entries. For a corpus that lives in files, generate that block before
compiling. A few lines of script does it:

```typescript
// gen-docs.ts — inline ./corpus/*.md into the spec's indexing.documents
import { Glob } from "bun";

const documents = [];
for await (const path of new Glob("corpus/**/*.md").scan(".")) {
  documents.push({ id: path.replaceAll("/", "-"), text: await Bun.file(path).text() });
}
// JSON is valid YAML — paste this under `indexing:` as the documents block.
console.log(JSON.stringify({ chunkStrategy: "markdown", chunkSize: 800, chunkOverlap: 0, documents }, null, 2));
```

Splice the output into `crewhaus.yaml` (or template the whole spec
from it) and recompile. Keeping the generation step explicit is the
point: the compiled bundle is self-contained, so what you indexed is
exactly what's in the spec — reviewable in the same diff.

## Filtering — metadata-aware retrieval

You can tag chunks with metadata and filter at retrieve-time:

```yaml
documents:
  - id: section-19
    metadata: { section: 19, status: shipped }
    text: |
      ...
  - id: section-22
    metadata: { section: 22, status: planned }
    text: |
      ...
```

Then in the agent's prompt:

```
When the user asks about a specific section, call
Retrieve({ query: ..., filter: { section: <n> } }).
```

Filters are a flat key → value record, applied as exact-match
predicates. Filter strings that look like injection (`'`, `"`, `;`,
`--`) are rejected at the boundary, so an attacker-controlled query
can't bend the predicate on the SQL-ish backends.

## Things that look like RAG but aren't

| Symptom                                                            | Wrong shape  | Right shape                                       |
| ------------------------------------------------------------------ | ------------ | ------------------------------------------------- |
| Autonomous goal decomposition over the corpus.                     | pipeline     | [research](07-autonomous-research.md)             |
| Real-time web search, not a fixed corpus.                          | pipeline     | [cli](01-cli-coding-agent.md) with `WebSearch`    |
| One-shot summarization of a single doc.                            | pipeline     | [workflow](02-sequential-workflow.md)             |
| Per-tenant corpora that must not cross-contaminate.                | pipeline     | [managed](11-managed-multitenant.md) + pipeline    |

Pipeline is the right answer when the **boundary of what the agent
knows** is the corpus you indexed. If the agent should also be able
to fall back to general knowledge, pair it with a CLI agent in front:
the CLI decides whether to invoke the pipeline as a sub-agent.

## Production knobs

- **Re-indexing.** Currently a full recompile. There is no separate
  incremental `index` command yet — the corpus is baked into the
  bundle, so any corpus change means recompiling (`crewhaus compile`),
  and the chunk → embed → store pass reruns at the next process start.
- **Embedding call volume.** Indexing embeds every chunk at each
  process start (chunking itself never calls a model — even the
  `semantic` strategy is `Intl.Segmenter`-based). With a paid
  embedder, watch restart frequency × corpus size; with `mock/det` or
  a `local/` embedder it's free.
- **Persistence.** `in-memory` rebuilds every restart. For an
  on-disk index switch to `lance` and point `retrieve.url` at the
  index directory (for `lance`, `url` is the filesystem path; add
  `collection:` to name the table).

## What to read next

- **Test RAG accuracy.** [Recipe 12 — Eval Harness](12-eval-harness.md) —
  the eval target treats the pipeline as a black box.
- **Multi-step research over the same corpus.** [Recipe 07 — Autonomous Research](07-autonomous-research.md).
- **Per-tenant corpora.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- **Local embedders to avoid API costs.** [Recipe 32 — Local Models](32-local-models.md).

## Pointers to source

- **Example:** [`starters/rag/crewhaus.yaml`](../starters/rag/crewhaus.yaml).
- **Codegen:** [`packages/target-pipeline`](https://github.com/crewhaus/factory/blob/main/packages/target-pipeline).
- **Engine:** [`packages/pipeline-engine`](https://github.com/crewhaus/factory/blob/main/packages/pipeline-engine).
- **Chunkers:** [`packages/chunker`](https://github.com/crewhaus/factory/blob/main/packages/chunker).
- **Embedder:** [`packages/embedder`](https://github.com/crewhaus/factory/blob/main/packages/embedder).
- **Vector store:** [`packages/vector-store`](https://github.com/crewhaus/factory/blob/main/packages/vector-store).
- **Retrieve tool:** [`packages/tool-retrieve`](https://github.com/crewhaus/factory/blob/main/packages/tool-retrieve).
- **Spec schema (pipeline variant):** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts) (search `pipelineSchema`).
- **Module catalog reference:** §21, §30 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
