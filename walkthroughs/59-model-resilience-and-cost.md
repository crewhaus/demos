# Recipe 59 — Model resilience & cost

**Catalog modules:** `model-router`, `routing-store`, `circuit-breaker`, `model-market-scan`, `model-right-size`, `pricing-feed`, `cost-tracker`.
**Shipped:** crewhaus 0.2.0 (`agent.model_fallbacks` + `circuit_breaker`, `budget:`, `model_tiers`, `crewhaus model-scan`, `crewhaus model right-size`); `agent.model_pool` + `crewhaus route` in 0.2.1; online exploration (`learning.bandit` — ε-greedy / Thompson), `crewhaus route explain`, the pipeline/research/batch/browser rollout, and advise scoreboard-mining in 0.2.2; per-model settings, per-candidate narrowing, hybrid strategies and the `models` verb family in 0.6.0 ([Recipe 75](75-hybrid-models.md) is the hybrid recipe).

[Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md)
originally opened with a caveat: "fallback is a TypeScript-level
pattern, not a spec field... there is no `fallbackModels:` YAML to
reach for." 0.2.0 changed that. Provider failover, a run-level budget cap with a
degradation ladder, and a two-tier turn-difficulty router are all
**declarative spec blocks** now — no hand-wiring. This recipe is the
declarative counterpart to Recipe 18's manual approach; reach for the
spec blocks first and drop to the TypeScript seam only when you need
per-call control.

You'd reach for this when:

- Your agent is **user-facing** and one provider rate-limiting
  shouldn't take it down.
- You want a **hard dollar ceiling** per run, with graceful
  degradation instead of a hard stop.
- You want to **spend less** — route easy turns to a cheap model, and
  periodically re-check whether a cheaper model still holds quality.

## Prerequisites

- [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md)
  for the circuit-breaker state machine (closed / open / half-open) and
  the `model:` prefix grammar (`openai/`, `bedrock/`, `groq/`, …). The
  spec blocks below are thin declarative wrappers over exactly that
  machinery.
- [Recipe 19 — Rate Limiting and Budgets](19-rate-limiting-and-budgets.md)
  for the per-tenant budget model the run-level `budget:` block
  complements.

## Declarative provider failover

`agent.model_fallbacks` is an ordered list of models tried when the
primary's circuit breaker is open. `agent.circuit_breaker` tunes the
per-candidate breakers — field names mirror `@crewhaus/circuit-breaker`
exactly (`failureThreshold` / `windowMs` / `cooldownMs`), with the
package defaults (5 failures / 60s window / 30s cooldown) applying per
field when omitted:

```yaml
name: support-agent
target: cli
version: 1
agent:
  model: claude-sonnet-5
  instructions: |
    Answer the user's support question. Cite the doc you used.
  model_fallbacks:
    - openai/gpt-4o
    - groq/llama-3.3-70b-versatile
  circuit_breaker:
    failureThreshold: 3
    windowMs: 60000
    cooldownMs: 30000
tools: []
```

Each fallback entry follows the same model-string grammar as
`agent.model`. Cross-provider fallbacks resolve their own credentials
lazily — a fallback with a missing key warns at boot and is skipped
when tried, never hard-failing the run. The primary emits a
`model_failover` trace event when it hands off, and auto-restores on a
half-open probe.

Declaring `circuit_breaker` **without** `model_fallbacks` is valid too:
the primary adapter alone gets breaker-wrapped, so it fail-fasts on a
degraded provider instead of hammering it.

The recovery path also composes with the failure taxonomy — a
`switch-model` recovery action re-issues the same turn onto the next
failover candidate:

```yaml
failure_taxonomy:
  - class: provider-529
    pattern: "overloaded"
    recovery: switch-model
```

## Run-level budget cap with a degradation ladder

The `budget:` block generalizes the optimizer's `--budget-usd` to
normal runs. `usd` is the dollar ceiling; `on_exceed` decides what
happens when accrued spend reaches it. The check is pre-turn, so an
in-flight turn always completes:

```yaml
name: support-agent
target: cli
version: 1
agent:
  model: claude-sonnet-5
  instructions: Answer the user's support question.
tools: []
budget:
  usd: 5.00
  on_exceed:
    action: degrade
    model: claude-haiku-4-5
```

`on_exceed` is a discriminated union:

- `{ action: stop }` — end the run cleanly before the next turn (the
  default when `on_exceed` is omitted).
- `{ action: degrade, model: <cheaper> }` — re-resolve the primary
  model to the cheaper one and continue; a later breach on the degraded
  model stops the run.

The same ceiling is available as a per-run flag for ad-hoc runs, no
spec edit needed:

```bash
crewhaus run crewhaus.yaml --budget-usd 2.00
```

## Two-tier turn-difficulty router

Most turns are easy. `model_tiers` routes each turn to a `fast` (cheap)
or `default` (full-power) model from deterministic signals — estimated
context tokens, whether tools are in play, turn index, prior-turn
tool-use density. A fast-tier turn that *fails* re-runs on `default`
(misroute recovery), so cheapness never costs correctness:

```yaml
name: support-agent
target: cli
version: 1
agent:
  model: claude-sonnet-5
  instructions: Answer the user's support question.
  model_tiers:
    fast: claude-haiku-4-5
    default: claude-sonnet-5
    routing:
      contextTokenThreshold: 10000
      toolsToDefault: true
      firstTurnToDefault: false
tools: []
```

All `routing` knobs are optional — sensible defaults apply. Omit
`model_tiers` entirely and you get single-model behaviour and
byte-identical bundles.

> These are **cost/quality** routing knobs. `model_fallbacks` is for
> **availability** — a safety net when a provider is down, not a
> routing strategy. Use both; they compose (a tier's model can itself
> have a fallback chain).

## Adaptive model pool (learns which model wins)

`model_tiers` is two models split by a fixed heuristic. **`model_pool`**
(v0.2.1) generalises it: declare *N* candidates and a selection `policy`,
and — with `policy: learned` — the harness learns which model wins each
kind of turn the more you run it. It is the superset of `model_tiers`, so
it *replaces* it (and is mutually exclusive with `model_fallbacks`). As of
v0.2.2 it works on the `cli`, `channel`, `managed`, `pipeline`, `research`,
`batch`, and `browser` shapes, and routes on both compiled bundles and the
interpreted `crewhaus run` path:

```yaml
name: support-agent
target: cli
version: 1
agent:
  model: claude-sonnet-5
  instructions: Answer the user's support question.
  model_pool:
    policy: learned              # static | heuristic (default) | learned
    candidates:
      - { model: claude-haiku-4-5, tags: [cheap] }
      - { model: claude-sonnet-5, tags: [balanced] }
      - { model: claude-opus-5, tags: [strong] }
    objective: { quality: 0.7, cost: 0.2, latency: 0.1 }
    learning:
      minSamplesPerArm: 25
      bandit: thompson           # epsilon-greedy (default) | thompson   (v0.2.2)
      explorationRate: 0.05      # ε for epsilon-greedy; ignored by thompson
tools: []
```

- **`static`** always uses the first candidate.
- **`heuristic`** (the default) routes hard turns to a `strong`-tagged
  candidate and easy turns to a `cheap` one — the same difficulty signals
  as `model_tiers`, applied over your tags.
- **`learned`** keeps a durable reward scoreboard at
  `.crewhaus/routing/arms.jsonl`, keyed by `(difficulty band, model)`.
  Each turn it folds the outcome — success, latency, and cost (a *failed*
  turn scores 0, so a fast failure can't out-rank a reliable model) — back
  in, exploring each candidate a few times (`minSamplesPerArm`) before
  exploiting the best. So the choice **improves the more you run the
  harness**.

Once every candidate in a band is warmed up, a `learned` pool would exploit
the best arm forever — which never notices when a model drifts or improves.
Since **v0.2.2** it keeps exploring online (`learning.bandit`): the default
`epsilon-greedy` tries a non-best arm `explorationRate` of the time, and
`thompson` draws each arm from its reward posterior and self-balances (no ε
to tune). Both are seeded from the transcript, so exploration is still
**replayable and deterministic** — `explorationRate: 0` reproduces the
pre-0.2.2 exploit-only behaviour byte-for-byte.

Every pick is a `model_route` trace event. Inspect what the pool has
learned, replay one run's decisions, or wipe the scoreboard, from the CLI:

```bash
crewhaus route status                 # per-band arms, best-per-band starred
crewhaus route status --by profile    # regroup by the models: profile that served (0.6.0)
crewhaus route status --shadow        # include the observe-only lanes (0.6.0)
crewhaus route explain <session>      # replay one run's per-turn decisions (v0.2.2)
crewhaus route freeze <policyVersion> # pin the policy; --clear lifts it (0.6.0)
crewhaus route propose                # mine the scoreboard into a review bundle (0.6.0)
crewhaus route reset                  # kill switch
```

From 0.6.0 `route explain` is a **timeline** rather than a route table: each
turn's decision, the `/model` directives it accepted or refused, and every
draft → grade → escalate transition with the model and cost of each.

You don't have to tune the pool by hand: **`crewhaus advise` mines the
scoreboard** and proposes policy tweaks — flip `policy` to `learned` once a
band has enough samples, or add an `explorationRate` to a converged pool —
as eval-gated SpecPatches you apply through `optimize --from-advice`. (It
never edits the candidate roster; that stays yours.)

> The candidate roster is yours — learning only tunes selection *within*
> the set you declare, never the set itself (model fields stay outside the
> optimizer's reach). Since 0.6.0 a candidate is no longer just a model
> string: it carries its own `fallbacks`, `circuit_breaker`, request params,
> tools, permissions and spend cap — see the next section.

## Per-model settings and hybrid lanes (0.6.0)

Everything above treats a candidate as a model id with tags. 0.6.0 makes it a
full **profile**: declare each model once in a top-level `models:` block, and
reference it as `$<name>` from any model slot.

```yaml
models:
  fast:
    model: claude-haiku-4-5
    tags: [cheap]
    max_tokens: 2048
    temperature: 0.2
  strong:
    model: claude-opus-5
    tags: [strong]
    thinking: { effort: high }
```

A pool candidate may then carry the same fields **inline**, which is where
per-model narrowing lives — `tools` (subset-only), `permissions` (`deny` and
`ask` only, never `alwaysAllow`), `rate_limits`, `limits`, `caching` and a
per-lane `cost.max_usd` that makes the lane ineligible when spent rather than
ending the run. That is what makes a cheap lane structurally cheap instead of
cheap by hope, and it is why a pool now beats `model_tiers` on more than
policy.

The lanes can also be composed into a **strategy** — a cascade that drafts on
the cheap arm and hands a failed draft to a stronger one, a guide, a shadow
lane, a committee — and `evaluation.on_fail: escalate` turns an in-loop
judge's verdict into that hand-off. Three offline verbs read the result
before you spend anything:

```bash
crewhaus models list        # the resolved profile registry
crewhaus models explain     # every slot, the strategy, the per-shape verdict
crewhaus models audit       # pricing coverage, requires:, parameter acceptance
```

[Recipe 75 — Hybrid models](75-hybrid-models.md) builds the whole
cheap-worker / strong-judge setup end to end; this recipe stays the
reference for the availability and cost knobs underneath it.

## Right-size: is a cheaper model good enough?

`crewhaus model right-size` runs a downshift search — enumerate cheaper
siblings, compile, eval each against your dataset, and recommend a
downshift only when pass rate holds within tolerance. Proposal-only
unless `--write`:

```bash
crewhaus model right-size crewhaus.yaml \
  --dataset registry:support-agent-ratings \
  --graders eval/graders.yaml \
  --min-cost-drop 0.2 \
  --pass-rate-tolerance 0.02 \
  --seed 42
```

`--min-cost-drop 0.2` means "only recommend if it's at least 20%
cheaper"; `--pass-rate-tolerance 0.02` means "a 2-point pass-rate dip is
acceptable for that saving." Add `--write` to apply the winning
downshift via a comment-preserving CST edit (model fields are outside
`OPTIMIZABLE_PATHS`, so this is a deliberate, always-human-initiated
bypass — never something the optimizer does on its own).

## Market scan: has a better model shipped?

`crewhaus model-scan` is the scheduled market watch. It enumerates
capability-compatible replacements for your current model, evals each on
your dataset, and emits a proposal (+ `patch.json`) when a candidate
beats current on score at lower cost:

```bash
crewhaus model-scan crewhaus.yaml \
  --dataset registry:support-agent-ratings \
  --graders eval/graders.yaml \
  --same-provider \
  --limit 6
```

`--same-provider` keeps candidates to same-provider siblings (preserves
credentials and prompt cache). It's proposal-only unless `--write`.
Feed the winner into a canary
([Recipe 58](58-safe-production-ops.md)) to roll it out safely.

Keep the pricing table fresh so the cost math is right, and let
`doctor` flag models that silently bill $0 because they're missing from
the table:

```bash
crewhaus pricing sync --file pricing.json   # load a versioned pricing feed
crewhaus doctor --models                    # flag unpriced models + known sunsets
```

Since 0.6.0 `doctor --models` walks **every** model slot — pool candidates,
judges, per-step models, the degrade target — instead of `agent.model` and
`compaction.model` alone, so an unpriced arm can no longer report as "checks
passed". Its contract is otherwise unchanged: a **warning never fails it**, so
a sunset that passes on a calendar day cannot redden a pinned `doctor` check.
The gate lives in the new verb — `crewhaus models audit` walks the same slots
and **exits 1** on a model already past its retirement date (`--fail-on none`
reports without failing, `--fail-on sunset` also fails on an announced future
one). `doctor` prints a line saying exactly that.

## Benchmark several models at once

`eval --models` runs the same dataset + graders once per model — one
command, one comparison table:

```bash
crewhaus eval crewhaus.yaml \
  --dataset registry:support-agent-ratings \
  --graders eval/graders.yaml \
  --models claude-sonnet-5,claude-haiku-4-5,openai/gpt-4o \
  --seed 42
```

Each cell writes to `<out>/<model-slug>/` and the run emits a
`matrix.json` + `index.html`. Use it to pick the `default` tier, the
`fast` tier, and a fallback candidate from evidence rather than a hunch.

0.6.0 adds the two things that make the table decidable. `--record` runs each
cell through the run-history flow so every arm keeps its **own** baseline
lineage, and `crewhaus eval leaderboard <matrix-dir>` ranks the arms with a
paired sign-flip permutation test, Holm-corrected — refusing to name a winner
it cannot support (`UNDERPOWERED` below the comparable-pair floor, `TIE` when
the intervals overlap):

```bash
crewhaus eval crewhaus.yaml \
  --dataset registry:support-agent-ratings \
  --graders eval/graders.yaml \
  --models 'claude-sonnet-5,claude-haiku-4-5' --record --seed 42
crewhaus eval leaderboard .crewhaus/evals/<matrix-dir>
```

To evaluate the way production actually routes instead of pinning one arm per
cell, use `--routing as-declared` — mutually exclusive with `--models`, since
a matrix already pins one arm per cell.

## Choosing between the knobs

| You want…                                              | Reach for                                  |
| ------------------------------------------------------ | ------------------------------------------ |
| The agent to survive a provider outage.                | `agent.model_fallbacks` + `circuit_breaker` |
| A hard per-run dollar ceiling.                          | `budget:` / `run --budget-usd`             |
| Cheap model for easy turns, full model for hard ones.   | `agent.model_tiers`                        |
| The harness to learn which of N models wins each turn.  | `agent.model_pool` (`policy: learned`)     |
| To know if a cheaper model still passes.                | `crewhaus model right-size`                |
| To know if a better model shipped.                      | `crewhaus model-scan`                      |
| A side-by-side model comparison.                        | `crewhaus eval --models` + `eval leaderboard` |
| Each model's own settings, tools and permissions.       | `models:` + per-candidate fields ([Recipe 75](75-hybrid-models.md)) |
| A cheap draft a stronger model checks and redoes.       | `model_pool.strategy.cascade` + `evaluation.on_fail: escalate` |
| Per-call breaker control the spec can't express.        | the TypeScript seam — [Recipe 18](18-multi-provider-fallback.md) |

## What to read next

- **The circuit-breaker state machine and prefix grammar these wrap.** [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- **Per-tenant budgets and rate limits.** [Recipe 19 — Rate Limiting and Budgets](19-rate-limiting-and-budgets.md).
- **Local models as a zero-cost fallback tier.** [Recipe 32 — Local Models](32-local-models.md).
- **Rolling a model swap out safely.** [Recipe 58 — Safe production ops](58-safe-production-ops.md).
- **The hybrid setup these knobs compose into.** [Recipe 75 — Hybrid models: cheap worker, strong judge](75-hybrid-models.md).

## Pointers to source

- **Model router:** [`packages/model-router`](https://github.com/crewhaus/factory/blob/main/packages/model-router) (failover / tier / pool routers).
- **Routing store:** [`packages/routing-store`](https://github.com/crewhaus/factory/blob/main/packages/routing-store) (the `learned` reward scoreboard).
- **Per-model plan + hybrid wiring:** [`packages/model-plan`](https://github.com/crewhaus/factory/blob/main/packages/model-plan), [`packages/model-service`](https://github.com/crewhaus/factory/blob/main/packages/model-service).
- **Circuit breaker:** [`packages/circuit-breaker`](https://github.com/crewhaus/factory/blob/main/packages/circuit-breaker).
- **Cost tracker + pricing:** [`packages/cost-tracker`](https://github.com/crewhaus/factory/blob/main/packages/cost-tracker).
- **Module catalog reference:** §17, §27 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
