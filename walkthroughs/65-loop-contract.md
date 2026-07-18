# Recipe 65 — Bounding an agent loop: limits, thinking, and hooks

**Pillar:** Pillar 1 — the compiler is the protagonist.
**Catalog modules:** `spec` (the grammar), `compiler` (lowering + the warning table), `ir`, `target-cli` (codegen), `runtime-core` (enforcement), `tool-loop-detection`, `rate-limiter`, `hooks-engine`, `adapter-anthropic` (thinking).
**Shipped:** crewhaus 0.4.0 (Batch A — `limits:`, `agent.thinking`, `agent.rate_limits`, `agent.streaming`, top-level `hooks:`).

Before 0.4.0 the shape of an agent loop was mostly *implicit* — the runtime had
its own tool-iteration cap, its own loop detector, no wall-clock ceiling you
could set from YAML, and thinking/rate-limiting lived in TypeScript if they
lived anywhere. Batch A makes the loop's boundaries **declarative spec keys the
compiler lowers and wires**: hard ceilings (`limits:`), a portable
extended-thinking selector (`agent.thinking`), per-tool rate limits
(`agent.rate_limits`), and lifecycle `hooks:`. Every one is optional — declare
only the boundary you want, and the runtime default stays authoritative for the
rest.

You'd reach for this when:

- An agent can wander into an **unbounded tool loop** and you want a hard cap,
  a wall-clock deadline, and an escalation ladder when it starts repeating
  itself.
- You want **extended thinking** on the main turns without hand-editing the
  provider request — and without pinning the budget to one provider's units.
- A tool wraps a **rate-limited API** and you want the loop to back off on that
  one tool instead of the whole run dying.
- You want a **shell command to fire at a lifecycle point** — announce at
  session start, scan a URL before a fetch, persist a summary on stop.

## Prerequisites

- [Recipe 01 — CLI coding agent](01-cli-coding-agent.md) for the `cli` shape and
  the `compile` → `run` cycle these keys ride on.
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) if you want
  the `.crewhaus/settings.json` layering that spec `hooks:` compose *below*.

## The spec

Every key below is real 0.4.0 grammar — this file compiles clean (`crewhaus
compile bound-research.yaml -o dist`) and runs (`crewhaus run
bound-research.yaml`):

```yaml
name: bound-research
target: cli
agent:
  model: claude-sonnet-4-6
  instructions: Answer research questions using the web tools, then stop.
  thinking:
    effort: medium          # or: budget_tokens: 8192  — exactly one
  streaming: true
  rate_limits:
    webSearch:
      rpm: 20
      burst: 5
    "*":                    # catch-all bucket for every other tool
      rpm: 120
tools: [webSearch, webFetch]
limits:
  max_tool_iterations: 25
  deadline_ms: 600000       # 10 min — whole run
  turn_timeout_ms: 120000   # 2 min — one turn
  loop_detection:
    window: 10
    threshold: 3
    escalation: justify
hooks:
  - event: session-start
    command: ./hooks/announce.sh
  - event: pre-tool
    matcher: webFetch
    command: ./hooks/scan-url.sh
    timeout_ms: 5000
  - event: stop
    command: ./hooks/save-summary.sh
```

Note the shape split: `limits:` and `hooks:` are **top-level** keys, while
`thinking`, `streaming`, and `rate_limits` sit **under `agent:`**. That's not
cosmetic — `limits`/`hooks` are cross-cutting loop concerns carried on every
loop-running shape (`cli`, `channel`, `managed`, `workflow`, `graph`, `crew`,
`research`, `batch`, `browser`), whereas `rate_limits` is an agent-block concern
on the interactive shapes (`cli`, `channel`, `managed`).

## `limits:` — hard ceilings for one loop

Each field is an independent ceiling; omit the ones you don't want.

| Key                     | Bounds                          | Notes                                                        |
| ----------------------- | ------------------------------- | ----------------------------------------------------------- |
| `max_tool_iterations`   | tool-use round-trips per turn   | **Optimizer-reachable** — `["limits","max_tool_iterations"]` is in `spec-patch`'s `OPTIMIZABLE_PATHS`. |
| `max_concurrent_tools`  | parallel tool executions        | Ceiling per parallel block.                                  |
| `context_limit`         | context tokens                  | Hard cap that overrides the model's own.                    |
| `deadline_ms`           | wall-clock, **whole run**       | On fire, aborts the root of the abort tree.                 |
| `turn_timeout_ms`       | wall-clock, **one turn**        | Aborts just the turn.                                        |
| `model_call_timeout_ms` | wall-clock, **one model call**  | Aborts the turn — it can't proceed without the call.        |
| `loop_detection`        | runaway-loop tuning             | See below.                                                  |

The crew shape adds a `limits.crew` sub-block (`max_activations`,
`refusal_depth`, `max_a2a_depth`) for orchestration-level ceilings; the base
`limits` object rejects that `crew` key on every other shape.

### `loop_detection` — the escalation ladder

`window` is the trailing tool-call window inspected (default 10); `threshold`
is how many identical calls inside it count as a loop (**must be > 1** — a
single repeat is normal; default 3). The detector has a near-duplicate tier —
same tool, inputs identical after stripping volatile substrings
(numbers/UUIDs/hashes/whitespace) — so trivial argument churn doesn't defeat it.

`escalation` picks what happens when a signature trips detection **again** after
its one-time warning was ignored:

- **`warn`** (default) — nothing further; a trace event only, byte-identical to
  the pre-0.4 warn-once behaviour.
- **`justify`** — inject a synthetic user message demanding a one-sentence
  justification tied to the session goal before the model may repeat the call.
  (Deliberately *not* the permission-engine justification gate from
  [Recipe 53](53-justification-gates.md) — that gate advertises a
  `justification` input field in the tool schema at compile time, and
  retrofitting descriptors mid-run would change the tool schema under the model.
  The synthetic nudge is the proportionate in-band mechanism.)
- **`abort`** — end the turn, `ToolLoopLimit`-style: an `error` event named
  `ToolLoopAbort` is logged and the state machine takes the Aborted transition,
  exactly like the `max_tool_iterations` cap.

## `agent.thinking` — portable extended thinking

Exactly one of two forms (a `.strict()` schema rejects both-or-neither):

- **`budget_tokens: n`** — an explicit thinking-token budget, `n >= 1024`,
  passed to the provider verbatim.
- **`effort: low | medium | high`** — a portable preset the adapter layer
  converts to a provider-appropriate budget. On budget-style providers
  (anthropic/bedrock/gemini) it maps through `EFFORT_THINKING_BUDGET_TOKENS`
  (`low: 2048`, `medium: 8192`, `high: 24576`); on native-effort providers
  (openai reasoning models) the `reasoningEffort` field is passed through and the
  budget ignored. Declaring `effort` sets **both** fields, and each adapter
  reads the one it supports — so the same spec is portable across providers.

Thinking applies to every **main-turn** model stream. Compaction and judge
side-calls are deliberately untouched: summarization and grading gain nothing
from spending thinking tokens.

## `agent.rate_limits` — per-tool backpressure

Keys are tool names (or `"*"` for the catch-all bucket); `rpm` is the sustained
requests-per-minute ceiling, `burst` an optional short-burst allowance on top.
At loop start the runtime builds a `@crewhaus/rate-limiter` with one token
bucket per entry (`refillPerSec = rpm/60`, `capacity = burst ?? rpm`), and every
tool execution acquires `tool:<name>` **before dispatch but after** the
permission / justification / egress gates — so a denied call never consumes a
token. A tool with neither a named bucket nor a `"*"` default is not gated.

The key property: an acquire that exhausts the wait budget fails **just that
call** with an `is_error` tool_result (`[rate-limited] …`) so the model can
adapt — it **never kills the run**. Independent of the model-call rate limiter.

## `agent.streaming` and `hooks:`

`streaming: true` streams partial output tokens (default false on cli). The
`--streaming` run flag forces it on regardless of the spec.

`hooks:` is the in-spec equivalent of `.crewhaus/settings.json` `hooks`
entries. Each entry spawns `command` at a lifecycle `event`, optionally filtered
by a `matcher` glob against the payload's `name`, with an optional
`timeout_ms`. The ten accepted events (`SPEC_HOOK_EVENTS`, pinned by a
cross-check test to hooks-engine's `HOOK_EVENTS` so they can't drift):

```
session-start  stop  pre-tool  post-tool  pre-model
post-model  pre-compact  post-compact  pre-slash  alert
```

Spec hooks layer **below** the settings.json layers: the generated bundle runs
`[...specHooks, ...loadHooks()]`, mirroring the permission RuleSet's
settings-over-yaml precedence. All hooks still *run* (any deny wins regardless
of layer); a later settings.json hook just wins on `mutate` key merges.

## What the compiler wires

The keys aren't decorative — the cli emitter threads each one into the bundle's
`runChatLoop(...)` call (`limits.deadline_ms` → `deadlineMs`, and so on). The
generated `dist/agent.ts` carries them verbatim:

```ts
const __specHooks = [
  { event: "session-start", command: "./hooks/announce.sh" },
  { event: "pre-tool", command: "./hooks/scan-url.sh", matcher: "webFetch", timeoutMs: 5000 },
  { event: "stop", command: "./hooks/save-summary.sh" },
] as const;
// ... inside runChatLoop({ ... }):
    thinking: { effort: "medium" },
    streaming: true,
    rateLimits: { webSearch: { rpm: 20, burst: 5 }, "*": { rpm: 120 } },
    maxToolIterations: 25,
    deadlineMs: 600000,
    turnTimeoutMs: 120000,
    loopDetection: { window: 10, threshold: 3, escalation: "justify" },
    hooks: [...__specHooks, ...__hooks],
```

An omitted key spreads *nothing* into `runChatLoop`, so the runtime default
stays authoritative — the same byte-identity posture as `crewhaus run`, which
threads the identical options fragment straight from the lowered IR.

## Compile warnings and `--strict`

The loop-contract keys are **fully wired on the shapes that accept them**, so
declaring them compiles clean — no warning. What the 0.4.0 warning framework
catches is the *other* failure mode: a key a shape's schema accepts (so it
parses) but whose emitter doesn't wire yet — legal-but-inert config you'd
otherwise ship believing it's live. Warnings always print to stderr, one line
each, as `warning[<code>] <path>: <message>`:

```console
$ crewhaus compile nightly-pipeline.yaml -o dist
crewhaus: warning[accepted-but-unwired] continuity: continuity is accepted on the workflow shape but its emitter does not wire it yet — the generated bundle prints the ignored-note comment
wrote dist/agent.ts
wrote dist/README.md
compiled bundle (2 file(s)) → dist
```

The bundle is still written and the exit code is 0 — a warning is advisory. Pass
`--strict` to escalate every warning to an error; the compile then fails
**before any file is written**:

```console
$ crewhaus compile nightly-pipeline.yaml -o dist --strict
crewhaus: warning[accepted-but-unwired] continuity: continuity is accepted on the workflow shape but its emitter does not wire it yet — the generated bundle prints the ignored-note comment
crewhaus: --strict: 1 compile warning(s) escalated to errors (see lines above)
$ echo $?
1
```

Wire `--strict` into CI and inert config can't land.

**Off-shape is a harder failure, not a warning.** `limits:`/`hooks:` are
accepted on the loop-running shapes only. Put `limits:` on a shape that doesn't
carry it (`voice`, `pipeline`, `eval`, `onchain*`) and the strict spec union
rejects it *at parse*, long before the warning table runs:

```console
crewhaus: spec validation failed:
  <root>: Unrecognized key(s) in object: 'limits'
```

That's deliberate — a ceiling silently ignored is worse than a build that stops
and tells you the key doesn't belong on that shape.

## When to NOT reach for these

- **To throttle model calls (not tools).** `agent.rate_limits` gates *tool*
  executions. Model-call rate limiting and provider failover are the
  `circuit_breaker` / `model_fallbacks` blocks — see
  [Recipe 59 — Model resilience & cost](59-model-resilience-and-cost.md).
- **To gate a tool on intent.** `loop_detection: justify` nudges a *repeating*
  loop; it does not evaluate whether a single call is authorized. That's the
  per-tool justification gate — [Recipe 53](53-justification-gates.md).
- **To spend thinking tokens everywhere.** `thinking` covers main turns only by
  design. If you're reaching for it to speed up compaction or grading, you don't
  want it — those side-calls skip it deliberately.

## What to read next

- **The evaluate half of the loop contract.** [Recipe 66 — Evaluation inside the serving loop](66-eval-in-loop.md) (Batch B).
- **The settings.json hooks these layer below.** [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
- **The justification gate `loop_detection: justify` is careful *not* to be.** [Recipe 53 — Justification gates](53-justification-gates.md).

## Pointers to source

- **Spec grammar:** `limitsObject` / `loopDetectionBlock` / `thinkingBlock` / `rateLimitsBlock` / `hookSchema` + `SPEC_HOOK_EVENTS` in [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts).
- **Warning table + escalation:** `ACCEPTED_BUT_UNWIRED` / `collectCompileWarnings` in [`packages/compiler/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/compiler/src/index.ts); the `--strict` gate in [`apps/cli/src/index.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/index.ts) (search `strictWarnings`).
- **IR threading + codegen mirror:** `loopContractRunOptions` / `mergeSpecHooks` in [`apps/cli/src/loop-contract.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/loop-contract.ts).
- **Runtime enforcement:** `loopDetection` / `rateLimits` / `thinking` on `RunChatLoopOptions` in [`packages/runtime-core/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/runtime-core/src/index.ts); effort presets `EFFORT_THINKING_BUDGET_TOKENS` in [`packages/adapter-anthropic/src/types.ts`](https://github.com/crewhaus/factory/blob/main/packages/adapter-anthropic/src/types.ts).
