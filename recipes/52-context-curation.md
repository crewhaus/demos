# Recipe 52 — Active context curation (Pillar 2)

`compaction-autocompact` and `compaction-snip` are *reactive*: they fire only when context is already at its limit, and they either cost a model call (autocompact) or accept information loss (snip). Tara Prasad Routray's [Stop Wasting Money on AI Context You Don't Need](https://levelup.gitconnected.com/stop-wasting-money-on-ai-context-you-dont-need-a11560205f98) (March 2026) documents 60–80% token reduction from a pre-compaction pass that:

1. Drops semantically duplicate items via embedding cosine similarity, and
2. Re-orders to front-load high-relevance items (since transformer attention favors prompt-start and prompt-end positions over the middle).

`compaction-curator` ships that pass as a pure-function pipeline. The hookup is opt-in via `spec.compaction.curate: true`.

## What this recipe covers

- The `curate(items, opts)` API
- Wiring `compaction.curate` and `compaction.dedupeThreshold` from the spec
- Letting `crewhaus optimize` tune both via `OPTIMIZABLE_PATHS`
- Skipping the autocompact model call when curation alone is enough

## A worked example — RAG retrieval

`tool-retrieve` returns top-K chunks for a query. Across a multi-turn conversation, the same chunks tend to surface repeatedly (the user re-asks variants of the same question; the agent re-retrieves to refresh context). Without curation, those duplicates pile up.

```typescript
import { curate } from "@crewhaus/compaction-curator";
import { Embedder } from "@crewhaus/embedder";

const embedder = new Embedder({ /* provider config */ });

// Each retrieved chunk has a precomputed embedding because tool-retrieve
// computed it for the vector search. We pass them through verbatim.
const items = retrievedChunks.map((c) => ({
  id: c.id,
  text: c.text,
  embedding: c.embedding,
}));

const result = await curate(items, {
  query: "what's the user actually asking",
  dedupeThreshold: 0.92,
  relevanceTopK: 5,
  embedder: (texts) => embedder.embed(texts),
});

console.log(`Curation: ${items.length} → ${result.items.length} items, saved ${result.bytesSaved} bytes`);
```

`result.items` is the order to inject into the prompt: deduped, top-5, descending by relevance. The first item the model sees is the most-relevant.

## Spec-side configuration

```yaml
# spec.yaml
name: support-rag
target: pipeline
agent:
  model: claude-sonnet-4-6
  instructions: |
    Answer support questions from the knowledge base.
retrieve:
  embedderModel: voyage-3-large
  defaultK: 10              # over-retrieve; curator filters to top-K
indexing:
  chunkSize: 800
  chunkOverlap: 100
  documents:
    - id: refund-policy
      text: |
        Refunds are processed within 5 business days of return receipt.
    - id: shipping-policy
      text: |
        Standard shipping takes 3-5 business days. Express ships next-day.
compaction:
  curate: true              # turn the curator on
  dedupeThreshold: 0.92     # default
  relevanceTopK: 5          # cap retrieved items per turn
```

The `defaultK: 10` + `relevanceTopK: 5` pattern is the recommended one: over-retrieve (cheap, embeddings are already in your vector DB), then curate down to the top-K (also cheap, since the chunks carry their embeddings).

## Why curate *before* compact

`compaction-autocompact` fires a model call to summarize the conversation. If curation drops 40% of duplicate items first, the autocompact trigger may not fire at all — that's a model call avoided. Stacked savings:

| Stage              | What it saves                                |
|--------------------|----------------------------------------------|
| Dedupe             | Tokens (no LLM call)                         |
| Relevance reorder  | Attention quality (no token saving alone)    |
| Top-K trim         | Tokens (no LLM call)                         |
| Skipped autocompact | Whole model call (the largest saving when it triggers) |

Routray's 60–80% reduction is the compound of all four.

## Eval-driven tuning

`spec-patch`'s `OPTIMIZABLE_PATHS` includes `["compaction", "curate"]`, `["compaction", "dedupeThreshold"]`, and `["compaction", "relevanceTopK"]`, so `crewhaus optimize <spec>` can find the curation tuning that maximizes the [12-metric rubric](12-eval-harness.md) score per dollar.

Recommended eval workflow:

1. Build a small dataset of queries + ground-truth answers.
2. Run `crewhaus eval --rubric 12-metric` once with curation disabled (`curate: false`).
3. Run again with curation enabled (`curate: true`, default knobs).
4. Compare `costPerUsefulOutput` and `answerFaithfulness`. If the curated run is cheaper without quality loss, ship it.
5. Optionally: `crewhaus optimize` to find a better `dedupeThreshold`.

## Edge cases

**Pure dedupe (no query supplied)**: curator only dedupes, never reorders. Useful for batch jobs that don't have a single "query" to score against.

**Items already pre-embedded**: skip the embedder arg entirely. The curator uses the precomputed vectors. This is the recommended path when the items came out of `tool-retrieve` (which already embedded them for vector search).

**No embedder, no precomputed embeddings**: throws `CompactionCuratorError`. Either embed first or supply an embedder.

**Tiny inputs (N < 2)**: curation is a no-op; the function returns the input unchanged. No model call, no embedding call.

## Implementation pointers

- New package: [packages/compaction-curator/](../../factory/packages/compaction-curator/)
- Spec field: `CompactionPolicy.curate` (will be in `packages/spec` and `packages/ir` once v0.3.x lands the codegen integration; for now wire manually in your target's emitter)
- Optimizable paths: [packages/spec-patch/src/index.ts](../../factory/packages/spec-patch/src/index.ts) — `OPTIMIZABLE_PATHS.cli` includes the three keys

## Further reading

- Routray, "Stop Wasting Money on AI Context You Don't Need" (March 2026) — the original 60–80% reduction claim
- [recipe 12-eval-harness.md](12-eval-harness.md) — how to measure the savings
- [recipe 42-active-optimization.md](42-active-optimization.md) — closing the loop with `crewhaus optimize`
