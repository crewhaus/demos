# Recipe 18 — Multi-Provider Fallback

Wrap each model adapter in a circuit breaker. Consecutive failures
trip the breaker open; your wiring cascades to the next provider
when the primary is degraded. Automatic recovery via probe success.

One thing to be clear about up front: **fallback is a TypeScript-level
pattern, not a spec field.** The agent schema is strict —
`agent.model`, `agent.instructions`, `agent.sub_agents`, nothing
else — so there is no `fallbackModels:` YAML to reach for. What ships
is the building blocks: `@crewhaus/model-router` resolves any model
string to an adapter, and `@crewhaus/circuit-breaker` wraps an adapter
so it fail-fasts when degraded. The cascade loop is ~15 lines of your
own code, shown below.

You'd reach for this when:

- Your agent is **user-facing** and downtime is unacceptable.
- You operate across **multiple providers** (Anthropic + OpenAI +
  Bedrock) and want graceful degradation if one tier rate-limits.
- You want **automatic recovery** — once the primary heals, the
  agent goes back to it without a redeploy.

For dev / tests / single-tenant CLIs, skip this — pinning to one
model is simpler and the failure mode is loud rather than silent.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- Credentials for at least two providers (e.g.
  `ANTHROPIC_AUTH_TOKEN` + `OPENAI_API_KEY`).

## Try it

The circuit-breaker half of the fallback story is exercised by
[`smoke/section-27-smoke/smoke.ts`](../smoke/section-27-smoke/smoke.ts)
probe 3 (`bun run smoke:section-27`) — five injected failures trip
the breaker; a cooldown + probe success closes it. No standalone
hello-fallback demo ships yet; for a live two-provider hop you need
real Anthropic + OpenAI credentials, which is why a fixture-only demo
isn't expressive enough.

## The `model:` prefix grammar

```
claude-sonnet-4-6                                    → Anthropic
claude-opus-4-7                                      → Anthropic
openai/gpt-4o                                        → OpenAI
gemini/gemini-2.5-flash                              → Google (Gemini API or Vertex)
bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0 → AWS Bedrock
local/llama3.2@http://localhost:11434/v1             → Local OpenAI-compatible
groq/llama-3.3-70b-versatile                         → Groq (OpenAI-compatible host)
azure/<deployment>                                   → Azure OpenAI
vertex/claude-sonnet-4-6                             → Claude on Vertex AI
```

The model-router parses the prefix and lazy-loads only the matching
adapter. A spec with `model: claude-sonnet-4-6` never imports the
OpenAI SDK; a spec with `model: openai/gpt-4o` never imports the
Anthropic SDK. Cold start scales with what you actually use.

The named OpenAI-compatible hosts (`groq/`, `together/`, `fireworks/`,
`openrouter/`, `deepseek/`, `xai/`, `mistral/`, `cerebras/`) make
cheap fallback targets: each reads its own key env var
(`GROQ_API_KEY`, …), so adding one to a fallback chain never collides
with your `OPENAI_API_KEY`. See
[Recipe 32 — Local Models](32-local-models.md) for the full list.

## Wiring a fallback chain

The pattern: keep an ordered candidate list, resolve each model
string through the router, wrap each adapter in its own breaker, and
cascade on failure. All TypeScript — the spec stays a single
`agent.model`:

```typescript
import type { ProviderRequest, StreamEvent } from "@crewhaus/adapter-anthropic";
import { type WrappedAdapter, wrap } from "@crewhaus/circuit-breaker";
import { resolveModel } from "@crewhaus/model-router";

const CANDIDATES = [
  "claude-sonnet-4-6",
  "openai/gpt-4o",
  "groq/llama-3.3-70b-versatile",
];

const breakers = new Map<string, WrappedAdapter>();

async function adapterFor(modelString: string) {
  const { adapter, modelId } = await resolveModel(modelString);
  let wrapped = breakers.get(modelString);
  if (wrapped === undefined) {
    wrapped = wrap(adapter, { adapterName: modelString, bus }); // bus optional
    breakers.set(modelString, wrapped);
  }
  return { wrapped, modelId };
}

async function* streamWithFallback(
  req: Omit<ProviderRequest, "model">,
): AsyncIterable<StreamEvent> {
  let lastError: unknown;
  for (const modelString of CANDIDATES) {
    const { wrapped, modelId } = await adapterFor(modelString);
    if (wrapped.state() === "open") continue; // skip tripped providers, zero network
    try {
      yield* wrapped.stream({ ...req, model: modelId });
      return;
    } catch (err) {
      lastError = err; // breaker recorded the failure; try the next candidate
    }
  }
  throw lastError ?? new Error("all fallback candidates are open or failed");
}
```

Every model call:

1. Tries `claude-sonnet-4-6` (unless its breaker is open).
2. If the stream fails, the breaker counts it and the loop tries
   `openai/gpt-4o`.
3. If that also fails or its breaker is open, tries the Groq host.
4. If all fail, the call surfaces the last error.

Each candidate has **its own breaker** (the `breakers` map). A bad
Anthropic provider trips the Anthropic breaker but leaves the OpenAI
one healthy.

One streaming caveat: if the primary dies mid-stream, tokens have
already been yielded to the caller. Retrying a *partial* turn on the
next provider duplicates output — so cascade at turn granularity
(re-issue the whole request), not mid-stream.

## The circuit breaker

`circuit-breaker.wrap(adapter, opts)` from
[`packages/circuit-breaker`](https://github.com/crewhaus/factory/blob/main/packages/circuit-breaker) gives
the adapter three states:

| State        | Behavior                                                              |
| ------------ | --------------------------------------------------------------------- |
| `closed`     | Calls go through normally. Failures increment a counter.              |
| `open`       | Calls fail-fast with `CircuitBreakerOpenError`, no network touched. Your loop falls through to the next model. |
| `half_open`  | A probe call goes through. Success → `closed`; failure → `open`.      |

Options (`CircuitBreakerOptions`):

| Opt                 | Default              | Meaning                                                  |
| ------------------- | -------------------- | -------------------------------------------------------- |
| `failureThreshold`  | 5                    | Consecutive failures within `windowMs` that trip the breaker. |
| `windowMs`          | 60_000               | Window for counting consecutive failures.                |
| `cooldownMs`        | 30_000               | How long `open` stays open before a `half_open` probe.   |
| `adapterName`       | `adapter.providerId` | Identifier surfaced on `circuit_state_changed` events.   |
| `bus`               | none                 | Optional `TraceEventBus` for state-change events.        |
| `isFailure`         | every error counts   | Predicate for which errors count toward the threshold.   |

Per-model tuning is just per-call `wrap()` options — the secondary
can be more lenient than the primary:

```typescript
wrap(anthropicAdapter, { adapterName: "claude-sonnet-4-6", failureThreshold: 3 });
wrap(openaiAdapter, { adapterName: "openai/gpt-4o", failureThreshold: 10 });
```

The wrapped adapter also exposes `state()`, `reset()`, and `stats()`
(consecutive failures, transition count, last trip time) for
dashboards and manual intervention.

## What counts as a failure

By default, **every** error counts: a thrown stream error, a stream
that ends on an `error` event, and a stream that ends without a
`message_stop` (likely truncated) all increment the failure counter.
A clean `message_stop` resets it.

That default is deliberately blunt. If you don't want client-side
bugs (4xx schema-validation responses) or caller cancellations
tripping the breaker, pass an `isFailure` predicate that returns
`false` for them:

```typescript
wrap(adapter, {
  isFailure: (err) => !isAbortError(err) && !isInvalidRequest(err),
});
```

## Half-open probing

When `cooldownMs` elapses on an open breaker, the next call goes
through as a `half_open` probe. If it succeeds, the breaker closes;
if it fails, the breaker reopens with another `cooldownMs` wait.

So the recovery profile after a major outage looks like:

```
T+0:    primary fails repeatedly, breaker trips open
T+0:    every call uses fallback
T+30s:  next call probes the primary (half_open)
T+30s:  if the probe fails, back to open; if it succeeds, closed
T+30s:  every subsequent call (closed primary) returns to primary
```

The state machine is per-process and in-memory; each worker probes
independently.

## `circuit_state_changed` trace events

When `wrap()` is given a `bus`, every breaker transition publishes a
`CircuitStateChangedEvent`:

```json
{
  "kind": "circuit_state_changed",
  "adapter": "claude-sonnet-4-6",
  "fromState": "closed",
  "toState": "open",
  "reason": "5 failures in 4211ms"
}
```

(plus the standard trace envelope: `runId`, `sessionId`, `traceId`,
`spanId`, `timestamp`). `adapter` is whatever `adapterName` you
passed — use the model string so dashboards can tell candidates
apart. Without a bus, transitions are silent except for the `state()`
getter.

Pickup point: any subscriber on that trace bus. The structured event
printer (`CREWHAUS_TRACE=pretty|json`) renders breaker transitions in
red, so degradation stands out in live output. See
[Recipe 17 — Observability](17-observability.md) for the wider
trace-bus tooling.

## Bedrock setup

Bedrock makes a natural second provider for a Claude-primary chain —
same models, different control plane. Two gotchas:

- **Use the inference-profile id.** AWS requires the cross-region
  inference-profile id (geo prefix `us.` / `eu.` / `apac.` /
  `global.` / …) — not the bare model id — to invoke
  current-generation Claude and Llama models on demand:
  `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0`. The router
  accepts the prefix and infers the family from the rest of the id.
- **Credentials and region.** Auth is the standard AWS credential
  chain (`AWS_ACCESS_KEY_ID`/profile/IAM role) **or** a Bedrock API
  key via `AWS_BEARER_TOKEN_BEDROCK`. Region comes from
  `AWS_REGION`/`AWS_DEFAULT_REGION` or your AWS profile — there is no
  baked-in default, so an unset region fails loudly instead of
  silently invoking `us-east-1`.

Non-Anthropic Bedrock families (`meta.llama*`, `mistral.*`,
`amazon.nova*`, `cohere.command*`, `qwen.*`, `openai.gpt-oss*`)
stream via the Converse API and support tool use, so they can also
hold a fallback slot for tool-calling agents.

## Operational tuning

| Symptom                                                   | Adjustment                                          |
| --------------------------------------------------------- | --------------------------------------------------- |
| Breaker trips on transient blips.                         | Raise `failureThreshold` or shorten `windowMs`.     |
| Breaker stays open too long after recovery.               | Lower `cooldownMs`.                                 |
| Fallback gets traffic during minor primary slowness.      | Shorten the primary's `windowMs` so the counter resets faster. |
| Want manual reset.                                         | Call `reset()` on the wrapped adapter. No CLI verb — the breaker is per-process and in-memory; it also clears on restart, or transitions to `half_open` automatically once `cooldownMs` elapses. |

## Things that look like fallback but aren't

| Symptom                                                              | Better tool                                       |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Want a cheaper model first, the expensive one only for hard prompts. | A workflow with a router step in front.            |
| Want different models per role / step.                                | Per-role / per-step `model:` overrides.            |
| Want geo-routed providers (US users → US Anthropic).                  | Bedrock with a regional model id, or federation.   |

Multi-provider fallback is for **availability**, not cost or quality
optimization. Use it as a safety net; not as a routing strategy.

## Local development

For local dev, you usually want **no** fallback — failures should be
loud so you fix the actual problem. Since the breaker is wiring you
add (not something the compiled bundle injects), the dev posture is
simply: don't `wrap()`. Gate the wrapping on your own env flag if you
want one binary for both:

```typescript
const adapter = process.env.MY_APP_BREAKERS === "1" ? wrap(raw, opts) : raw;
```

Unwrapped, failures surface as ordinary errors with the original
provider error message.

## What to read next

- **Per-provider rate limiting.** [Recipe 19 — Rate Limiting and Budgets](19-rate-limiting-and-budgets.md).
- **Watch the breaker.** [Recipe 17 — Observability](17-observability.md).
- **Local models as the fallback.** [Recipe 32 — Local Models](32-local-models.md).

## Pointers to source

- **Model router:** [`packages/model-router`](https://github.com/crewhaus/factory/blob/main/packages/model-router).
- **Circuit breaker:** [`packages/circuit-breaker`](https://github.com/crewhaus/factory/blob/main/packages/circuit-breaker).
- **Adapters:** [`packages/adapter-anthropic`](https://github.com/crewhaus/factory/blob/main/packages/adapter-anthropic), [`packages/adapter-openai`](https://github.com/crewhaus/factory/blob/main/packages/adapter-openai), [`packages/adapter-gemini`](https://github.com/crewhaus/factory/blob/main/packages/adapter-gemini), [`packages/adapter-bedrock`](https://github.com/crewhaus/factory/blob/main/packages/adapter-bedrock).
- **Module catalog reference:** §17, §27 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
