# Recipe 68 — Retrieval-augmented agents with the `knowledge:` block

**Pillar:** Pillar 1 — the compiler is the protagonist (one spec block
compiles into the whole retrieval spine).
**Catalog modules:** `tool-retrieve` (R12), `embedder` (R12), `vector-store`
(R12).
**Shipped in:** crewhaus 0.4.0, Batch E / G22 ([CHANGELOG](https://github.com/crewhaus/factory/blob/main/CHANGELOG.md)).

CrewHaus has had a first-class retrieval engine for a while — but only on the
**pipeline** shape, behind its dedicated `retrieve:` / `indexing:` blocks
(recipe 06). An ordinary conversational agent that just needed to ground its
answers in a folder of docs had to hand-wire an MCP server or a custom tool.

Batch E closes that gap. A new optional `knowledge:` block on the
**cli / channel / managed** shapes registers the *same* chunk → embed →
vector-store engine the pipeline uses as a citation-bearing `Retrieve` tool.
Declare the block, point it at your docs, and the compiled bundle ingests the
corpus at boot and hands the agent a `Retrieve` tool — no glue code.

This recipe pairs that with the other half of Batch E's grounding story:
**`memory.autoRecall` is now default-on** when a `memory:` block is present, so
your agent recalls what it learned last session without a knob.

You'd reach for `knowledge:` when:

- The agent answers from a **fixed corpus** — a product manual, an internal
  wiki export, an API reference — and you want grounded, cited answers.
- You want RAG on a **plain conversational agent** (cli or a Slack/Discord
  channel bot, or a multi-tenant managed daemon) without standing up the
  pipeline shape.
- You want the retrieval knobs (`default_k`, chunk size/overlap) to be
  **optimizer-tunable** like any other spec key.

## What you'll build

A cli agent that answers questions about a small local docs folder, citing the
chunks it retrieved — plus the same block on a channel bot and a note on the
managed daemon.

## Prerequisites

- crewhaus 0.4.0 or later (`crewhaus --version`).
- An embedder credential in the environment. The default embedder is
  `openai/text-embedding-3-small`, so `OPENAI_API_KEY` covers the examples
  below; swap the model to stay within one provider.

## The `knowledge:` block

```yaml
name: docs-agent
target: cli
agent:
  model: claude-sonnet-5
  instructions: |
    You answer questions about our product using ONLY the docs corpus.
    Always call Retrieve first, then answer from the returned chunks and
    cite them by their [n] number. If Retrieve returns "no hits", say so —
    do not answer from prior knowledge.
knowledge:
  sources:
    - path: ./docs/manual.md
    - glob: ./docs/api/**/*.md
  embedder: openai/text-embedding-3-small
  vector_backend: in-memory
  default_k: 5
  chunk:
    size: 400
    overlap: 0
```

That is the whole surface. Every sub-key except `sources` is optional and
resolves to the same default the pipeline retrieve engine uses:

| Key              | Type / values                                              | Default                            |
| ---------------- | ---------------------------------------------------------- | ---------------------------------- |
| `sources`        | list; each entry is **exactly one** of `path` / `glob` / `url` | — (required, ≥ 1)              |
| `embedder`       | `@crewhaus/embedder` model string                          | resolution order below             |
| `vector_backend` | `in-memory` \| `lance` \| `qdrant` \| `pinecone` \| `weaviate` | `in-memory`                     |
| `default_k`      | int 1..50 — hits per `Retrieve` call                       | `5`                                |
| `chunk.size`     | int — chunk length in chars                                 | `400`                              |
| `chunk.overlap`  | int ≥ 0 — chunk overlap in chars                            | `0`                                |

The block is `.strict()`, so a typo'd sub-key (`chunks:`, `vectorBackend:`)
fails the build rather than silently doing nothing. Each `sources` entry is
also strict about the **exactly-one** rule — `{ path: …, glob: … }` in the same
entry is a compile error (`each knowledge source needs exactly one of
path/glob/url`).

> **Gotcha — presence wires the tool; you don't list it in `tools:`.** Just
> like the `memory:` block wires Remember/Recall by being present, declaring
> `knowledge:` registers the `Retrieve` tool on the catalog automatically. You
> don't add `Retrieve` to a tool list; you tell the agent (in `instructions`)
> to *use* it.

## What the agent sees

The registered tool is `Retrieve(query, k?, filter?)` — read-only,
concurrency-safe, described to the model as returning "a numbered list of hits
with citations." `k` defaults to your `default_k`; `filter` takes metadata
predicates. A call returns numbered hits, each carrying its id, source doc, and
score:

```
[1] id=manual.md#4 doc=./docs/manual.md score=0.8123
Rate limits are enforced per API key. The default ceiling is 600 requests…

[2] id=api/auth.md#1 doc=./docs/api/auth.md score=0.7440
Authenticate with a bearer token in the Authorization header…
```

Because every hit is a `[n]` with a `doc=`, the model can cite exactly which
chunk grounded each claim — that's the "citation-bearing" part. An empty corpus
or a miss returns the literal `no hits`, which is why the instructions above
tell the agent to surface that rather than fall back to memory.

## Run it

```bash
crewhaus run crewhaus.yaml
```

The bundle ingests every `sources` entry at boot — reading `path` files,
expanding `glob`s against the harness cwd, and fetching each `url` verbatim —
then chunks, embeds, and indexes them into the chosen `vector_backend` before
the first turn. The same ingest runs inside the compiled standalone bundle, so
`crewhaus compile` → run the bundle behaves identically.

## Embedder resolution order

A vector store needs embeddings, so knowledge RAG never degrades to lexical
BM25 the way the fact store can. The embedder is resolved in this order (G76,
enforced in one place — `resolveKnowledgeEmbedder` — so the three emitters
can't drift):

```
knowledge.embedder  →  memory.embedder  →  memory.wiki.embedder  →  target default
```

The target default is `openai/text-embedding-3-small`. So if your spec already
declares `memory.embedder`, a `knowledge:` block with **no** `embedder` reuses
it — one embedder credential covers both the fact store and the RAG corpus.

## The knobs are optimizer-tunable

`knowledge.default_k`, `knowledge.chunk.size`, and `knowledge.chunk.overlap`
join `OPTIMIZABLE_PATHS`, so the prompt optimizer (recipe 42) can tune your
retrieval geometry against an eval the same way it tunes the prompt. The
`sources` corpus stays **human-owned** — the optimizer never rewrites what you
point it at, only how much it pulls and how it chunks.

## On a channel bot and the managed daemon

The block is carried identically on `target: channel` and `target: managed` —
the two other interactive agent-loop shapes. A Slack/Discord bot grounded in a
docs corpus is the same three lines:

```yaml
name: support-bot
target: channel
agent:
  model: claude-sonnet-5
  instructions: |
    Answer support questions from the docs corpus, citing chunks by [n].
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
knowledge:
  sources:
    - glob: ./kb/**/*.md
```

On `target: managed` the same block ingests once at daemon boot and every tenant
shares the read-only index. (The pipeline shape keeps its dedicated
`retrieve:` / `indexing:` blocks — `knowledge:` is the agent-shape front door to
the *same* engine, not a replacement for it.)

## The other half of Batch E: recall is default-on now

Grounding in a fixed corpus is one axis; remembering the *conversation* is the
other. As of 0.4.0, **declaring a `memory:` block opts you into recall and
capture** (G46, mildly breaking):

```yaml
memory: {}          # or any memory config — presence is enough
```

With the block present, `autoRecall` now defaults to `true` (`"session-start"`)
and `autoCapture` to `true` (behind the existing `autoCaptureThreshold` gate) —
both previously defaulted to `false`. The resolved booleans are stamped into the
IR at lower time. To restore the old behavior, opt back out explicitly:

```yaml
memory:
  autoRecall: false
  autoCapture: false
```

`autoRecall` also gained a **cadence** (G21): it now accepts
`boolean | "session-start" | "per-turn"`. `"session-start"` (the default)
injects the recalled block once at boot; `"per-turn"` re-runs the recall closure
against the latest user message every turn and swaps the volatile recalled tail
block *without* re-injecting into the frozen cache prefix:

```yaml
memory:
  autoRecall: per-turn
  refreshEvery: 3        # re-recall every 3 turns; implies per-turn
```

> **Gotcha — `refreshEvery` + `autoRecall: false` is a compile error.**
> `refreshEvery` *is* the "every N turns" cadence knob, so it re-runs recall by
> definition. Declaring it while turning recall off is a contradiction and the
> compiler rejects it loudly. `memory.refreshEvery` is itself in
> `OPTIMIZABLE_PATHS`.

Knowledge (the fixed corpus) and memory (what this agent learned) compose: an
agent can `Retrieve` from the manual *and* recall the correction a user gave it
last week — one grounds facts, the other grounds context.

## When to NOT reach for `knowledge:`

- **You're on the pipeline shape.** Use its first-class `retrieve:` /
  `indexing:` blocks (recipe 06) — `knowledge:` is the agent-shape convenience
  over the same engine, and the pipeline needs the richer indexing surface.
- **The corpus is huge or updates constantly.** `knowledge:` ingests at boot;
  it's built for a bounded, mostly-static corpus. A live/streaming index wants a
  managed vector backend fed out-of-band, exposed to the agent as an MCP tool.
- **You picked an HTTP vector backend without provisioning it.** `qdrant` /
  `pinecone` / `weaviate` need a running store; `in-memory` (the default) and
  `lance` (on-disk) work with nothing else stood up.

## What to read next

- **The pipeline retrieve engine this reuses.** [Recipe 06 — RAG pipeline](06-rag-pipeline.md).
- **The optimizer that tunes `default_k` / chunk knobs.** [Recipe 42 — Active eval optimization](42-active-optimization.md).
- **The curator that trims what recall pulls in.** [Recipe 52 — Active context curation](52-context-curation.md).
- **Memory + recall in a running agent.** [Recipe 64 — The self-teaching expert](64-self-teaching-expert.md).

## Pointers to source

- **The `knowledge:` grammar + exactly-one-source rule:** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts) (`knowledgeBlock` / `knowledgeSourceSchema`).
- **Lowering to the IR:** [`packages/compiler/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/compiler/src/index.ts) (`lowerKnowledge`); embedder default-on for memory is `autoRecallOn` in the same file.
- **The `Retrieve` tool + `knowledgeRetrieve` ingest + `resolveKnowledgeEmbedder`:** [`packages/tool-retrieve/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/tool-retrieve/src/index.ts).
- **Emit wiring (kept in sync across shapes):** `renderKnowledge` in [`packages/target-cli/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/target-cli/src/index.ts), mirrored in `target-channel-bot` + `target-managed`.
