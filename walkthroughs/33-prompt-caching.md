# Recipe 33 — Prompt Caching

How `prompt-cache-manager` rotates Anthropic `cache_control` markers
on a 7-day-default schedule (a safety margin under Anthropic's 30-day
cache TTL), why it skips providers whose adapter does its own caching
(OpenAI and Gemini are server-managed; Bedrock Llama/Mistral have no
caching), and how to tune the rotation cadence to match your
prompt-stability profile.

You'd reach for explicit cache tuning when:

- Your agent has a **large stable system prompt** (skills registry,
  RAG corpus, instructions) and is re-invoked many times per day.
- You see **input-token costs dominate** your bill — caching cuts
  these by ~90% for the cacheable prefix.
- You're operating across **multiple providers** and want to
  understand per-provider cache behavior.

For low-volume CLI usage, caching is a nice-to-have — the manager's
defaults work without tuning.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- An Anthropic account (the explicit-caching path) for hands-on
  experimentation.

## Try it

The marker-rotation half of the story is exercised by
[`smoke/section-27-smoke/smoke.ts`](../smoke/section-27-smoke/smoke.ts)
probe 4: backdate a marker by 8 days, assert `manage()` injects a
fresh marker AND strips the old ones. Run with
`bun smoke/section-27-smoke/smoke.ts`. For long-stable-prompt agents
that benefit most from caching, see
[`starters/showcases/procode`](../starters/showcases/procode/crewhaus.yaml) and
[`starters/showcases/prochat`](../starters/showcases/prochat/crewhaus.yaml) — both ship
`compaction:` blocks, so caching (handled adapter-side) and
summarization keep the cacheable prefix stable across a long session.

## How Anthropic prompt caching works

Anthropic's API accepts `cache_control: { type: "ephemeral" }`
markers on system blocks. Marked blocks (and everything that comes
before them in the request) are eligible for cache reuse on
subsequent requests.

Cache lifetime:

- A cache entry's marker is valid up to Anthropic's **30-day TTL**;
  once the marker ages past TTL it silently stops being a cache hit.
- Cache **hits** cost ~10% of fresh input tokens; cache **writes**
  cost ~125% of fresh input tokens (one-time write cost).

So the math is: as long as your system prompt is re-sent at least a
couple of times before the marker expires, caching saves money. Below
that, the write cost dominates. The manager's job is to refresh the
marker proactively so a long-running daemon never drifts past the TTL
and goes cold.

## Why the manager exists

Without management, you'd have to:

- Decide which system blocks to mark `cache_control`.
- Rewrite the mark periodically (markers are tied to specific token
  positions; small prompt edits can invalidate them).
- Skip the mark on providers that don't support it.

The `prompt-cache-manager` ([packages/prompt-cache-manager](https://github.com/crewhaus/factory/blob/main/packages/prompt-cache-manager))
encapsulates this:

```typescript
import { manage } from "@crewhaus/prompt-cache-manager";

const result = manage(systemBlocks, {
  features: adapter.features,        // required: gates on caching policy
  lastRotatedAt,                     // last refresh (ms epoch); 0/undefined forces refresh
  rotateAfterMs: 7 * 24 * 3600 * 1000, // optional; default 7 days
});
// result.blocks    — the (possibly mutated) system blocks
// result.rotated   — true if a fresh marker was written this turn
// result.rotatedAt — new lastRotatedAt the caller persists
```

When it rotates, it returns a system-block array with a single fresh
`cache_control` marker placed on the **last** block; existing markers
on the other blocks are stripped. The marker is **rotated** on a
schedule, and the caller is responsible for persisting `rotatedAt`
between runs.

## The rotation policy

The manager is **stateless**: it holds no file of its own. The caller
threads a single `lastRotatedAt` timestamp (ms epoch) in and gets a
fresh `rotatedAt` back to persist — in the runtime that lives in the
state-store, surfaced as `RunChatLoopOptions.promptCacheLastRotatedAt`.

Rules (from `manage()`):

1. **Skip entirely** when `features.caching !== "explicit"` (see next
   section) or when there are no system blocks — the input is returned
   unchanged with `rotated: false`.
2. **Rotate if** `lastRotatedAt` is `0`/undefined (force-refresh on the
   first turn) **or** more than `rotateAfterMs` has elapsed since it
   (default 7 days).
3. Otherwise the marker is still fresh — return the input unchanged
   with `rotated: false`.

What "rotate" means concretely:

- The manager **strips all existing `cache_control` markers** from the
  earlier blocks.
- Places a single fresh `{ type: "ephemeral" }` marker on the **last**
  block.

So at any given moment, only the last block carries the marker. The
rotation ensures that marker is refreshed well before Anthropic's
30-day TTL, so a long-running daemon's cache never silently goes cold.

## Per-provider behavior

The adapter declares its caching policy:

| Provider                         | `features.caching` | Manager behavior                              |
| -------------------------------- | ------------------ | --------------------------------------------- |
| Anthropic direct                 | `"explicit"`       | Apply markers, rotate per policy.             |
| Anthropic on Bedrock             | `"explicit"`       | Apply markers, rotate per policy.             |
| OpenAI                           | `"automatic"`      | Skip — OpenAI caches server-side automatically. |
| Gemini                           | `"automatic"`      | Skip — Gemini does its own implicit caching at the API layer. |
| Bedrock Llama / Mistral          | `false`            | Skip — provider has no caching layer.          |

For mixed-provider specs, the manager looks at the **active** model's
adapter declaration. A fallback list with both Anthropic and OpenAI
gets the marker only when routed to Anthropic.

## Where it runs in the call path

`runtime-core` assembles the system blocks pre-stream, then calls
`manage` once before the model stream starts:

```
runChatLoop
  ├─ systemBlocks = [ userInstructions,
  │                   ...projectMemory,
  │                   ...skills ]
  ├─ if adapter.features.caching === "explicit":
  │     manage(systemBlocks, { features, lastRotatedAt })
  │       ↓
  │     (on rotation, systemBlocks gains one fresh cache_control marker)
  └─ adapter.stream(systemBlocks, ...)
```

The `manage` call is the only cache-aware step, and it is gated on
`adapter.features.caching === "explicit"` — so the adapter itself never
sees the rotation logic; it just receives already-marked blocks. Adding
a new adapter doesn't require any cache-aware code.

## Cost impact

Per Anthropic's published rates (subject to change; see
[`packages/cost-tracker/src/pricing.ts`](https://github.com/crewhaus/factory/blob/main/packages/cost-tracker)
for the pricing table the cost-tracker uses):

| Operation                        | Cost factor                                |
| -------------------------------- | ------------------------------------------ |
| Fresh input tokens               | 1.0× (baseline)                            |
| Cache write                      | ~1.25× the input cost (one-time per cache entry) |
| Cache read (hit)                  | ~0.1× the input cost                        |

For a 10k-token system prompt with 100 requests while the marker is
live:

- **Without caching**: 100 × 10k × 1.0 = 1,000,000 input tokens.
- **With caching**: 1 × 10k × 1.25 + 99 × 10k × 0.1 = 12,500 + 99,000
  = 111,500 input tokens.

~9× savings. The break-even is **about 2 hits per cache write**
(write cost / fresh cost = 1.25; one write + N hits = N × 0.1 +
1.25 must beat (N+1) × 1.0, giving N ≥ 2).

## Tuning

`ManageOptions`:

| Option           | Default                       | Notes                                          |
| ---------------- | ----------------------------- | ---------------------------------------------- |
| `features`       | _(required)_                  | The active adapter's `ProviderFeatures`; gates the no-op skip. |
| `lastRotatedAt`  | `0` (force-refresh first turn)| Last refresh, ms epoch. Caller persists `result.rotatedAt`. |
| `rotateAfterMs`  | 7 days (`DEFAULT_ROTATE_AFTER_MS`) | Rotation interval. |
| `now`            | `Date.now`                    | Override "now" for tests.                      |

When to tune:

- **`rotateAfterMs` shorter** (e.g. 24 hours) — for prompts that
  evolve daily (RAG corpus updated nightly, skills added often).
  Each rotation costs a cache write, so rotate only as often as
  the prompt actually changes.
- **`rotateAfterMs` longer** (e.g. 14 days) — for very stable prompts
  (large but unchanging system instructions). Keep it comfortably
  under Anthropic's 30-day TTL so the marker is refreshed before it
  expires.
- **Force a refresh** by passing `lastRotatedAt: 0` (or leaving it
  undefined) — `manage()` always rotates on the first turn, which is
  what you want for a one-off script that has no persisted timestamp.

## Observability

Cache hits show up in `cost_accrual` events via `cachedReadTokens`.
This is **disjoint** from `inputTokens`: `cost-tracker` copies
`inputTokens` from the raw `usage.input` (the *fresh*, full-price input
tokens Anthropic reports as `input_tokens`) and `cachedReadTokens` from
`usage.cacheRead` (the cache-served tokens billed separately at ~0.1×).
`computeCostMicros` charges them additively — full rate on
`inputTokens`, the cached-read rate on `cachedReadTokens` — so a turn
that served most of its prefix from cache shows a **small**
`inputTokens` and a **large** `cachedReadTokens`:

```json
{
  "kind": "cost_accrual",
  "provider": "anthropic",
  "modelId": "claude-sonnet-4-6",
  "inputTokens": 348,
  "cachedReadTokens": 9892,
  "outputTokens": 412,
  "costUsdMicros": 10192
}
```

(The raw stream usage that feeds this carries `cacheRead` and
`cacheCreate` token counts on the `message_start` event; `cost-tracker`
reads `cacheRead` into `cachedReadTokens` and ignores `cacheCreate` for
the accrual.)

`cost-tracker` aggregates these per run, per tenant, and per provider.
Since the two counts are disjoint, a useful cache-hit ratio is
`cachedReadTokens / (inputTokens + cachedReadTokens)` — the fraction of
total prompt tokens served from cache.

A healthy long-stable-prompt agent will see that ratio climb toward 1.0
on a steady-state hour. A low ratio suggests either that the marker is
ageing out before it gets reused, or a prompt that's churning more than
expected.

## Cache invalidation triggers

Things that invalidate a cache entry:

- **Any change to system blocks before the marker.** Even a one-byte
  diff in a stable block breaks the cache (it's position-tied).
- **Marker ageing past Anthropic's 30-day TTL.** This is what the
  manager guards against by rotating the marker on the `rotateAfterMs`
  schedule (default 7 days) well before TTL.
- **A rotation itself.** Refreshing the marker writes a new cache
  entry (one-time write cost), then subsequent requests hit it.

Things that **don't** invalidate:

- Conversation turns appended after the marked system blocks.
- New tool calls / tool results.
- Per-request variations after the marker.

So order matters: put **stable content first** in your system blocks
(instructions, skill registry, RAG corpus), then put **dynamic content
last** (today's date, current user context). Only the stable prefix
caches.

## Worked observation

The CLI echoes each `cost_accrual` bus event to stderr when
`CREWHAUS_TRACE_COST=1` is set (currently wired on the `crewhaus
optimize` path):

```bash
CREWHAUS_TRACE_COST=1 crewhaus optimize starters/cli/crewhaus.yaml 2>&1 | grep cost-call
```

Each line carries the per-call provider, model, token counts, and the
microdollar cost:

```
[optimize] cost-call provider=anthropic model=claude-sonnet-4-6 in=4823 out=412 micros=...
[optimize] cost-call provider=anthropic model=claude-sonnet-4-6 in=4892 out=280 micros=...
[optimize] cost-call provider=anthropic model=claude-sonnet-4-6 in=4951 out=339 micros=...
```

For the cache-read breakdown (`cachedReadTokens`), subscribe to the
trace bus directly — see [Recipe 17](17-observability.md). On a warm
cache the first call pays the write cost and subsequent calls serve
the bulk of their input tokens from cache.

## Things that look like cache tuning but aren't

| Symptom                                                            | Better tool                                       |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| Long-running daemon, intermittent prompt changes.                  | Default settings; the manager handles it.          |
| Per-tenant prompts with no cross-tenant sharing.                   | Default settings; the marker travels with each tenant's own system blocks. |
| Want to **disable** caching for a regulated workload.              | Route to a provider whose adapter doesn't cache (e.g. a Bedrock Llama/Mistral model); the manager skips automatically. |
| Want to **share cache** across agents with similar prompts.        | Caching is handled provider-side off the request prefix — identical system blocks reuse the same cache. |

## What to read next

- **Cost reporting that proves caching works.** [Recipe 17 — Observability](17-observability.md).
- **Multi-provider with mixed cache behavior.** [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- **Local models (no caching).** [Recipe 32 — Local Models](32-local-models.md).

## Pointers to source

- **Cache manager:** [`packages/prompt-cache-manager`](https://github.com/crewhaus/factory/blob/main/packages/prompt-cache-manager).
- **Runtime integration (calls `manage` pre-stream):** [`packages/runtime-core`](https://github.com/crewhaus/factory/blob/main/packages/runtime-core) (`RunChatLoopOptions.promptCacheLastRotatedAt`).
- **Anthropic adapter (consumes the markers):** [`packages/adapter-anthropic`](https://github.com/crewhaus/factory/blob/main/packages/adapter-anthropic).
- **Module catalog reference:** §27 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
