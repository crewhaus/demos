---
test:
  spec: starters/hybrid-support/crewhaus.yaml
  packages:
    - packages/model-plan
    - packages/model-service
    - packages/model-router
    - packages/routing-store
    - packages/tool-consult
---

# Recipe 75 — Hybrid models: cheap worker, strong judge

**Pillar:** Pillar 1 — the spec is the system.
**Catalog modules:** `model-plan`, `model-service`, `model-router`,
`routing-store`, `tool-consult`, `eval-report` (the leaderboard),
`cost-tracker`.
**Shipped:** crewhaus 0.6.0 (`models:` profile registry, `$profile`
references at every model slot, per-candidate tools / permissions / spend
caps, `model_pool.strategy.cascade`, `evaluation.on_fail: escalate`,
`crewhaus models list|explain|audit|propose`, `route explain`/`status --by`,
`eval leaderboard`).
**Starter:** [`starters/hybrid-support/`](../starters/hybrid-support/README.md).

A support harness declares one strong model because a handful of hard
questions need it. Every "where is my order" turn is then billed at that
model's rate — and adding a cheaper candidate to a pool does not fix it,
because the cheap candidate used to receive the same tools, the same
thinking budget, and the same self-grading judge as the expensive one.

0.6.0 makes the hybrid expressible: **cheap drafts with read-only tools →
a stronger checker grades → the strong model redoes the failures.** This
recipe builds exactly that, then shows you the three commands that prove
what actually happened.

You'd reach for this when:

- Most of your traffic is easy and a small tail is not, and you are
  paying tail prices on all of it.
- You want the cheap lane to be **structurally** cheap — fewer tools, a
  tighter output budget, no shell — rather than cheap by hope.
- You have been asked "is the cheap model actually good enough?" and you
  want to answer with a measurement instead of a hunch.

## Prerequisites

- [Recipe 59 — Model resilience & cost](59-model-resilience-and-cost.md)
  for `model_pool`, its policies, and the reward scoreboard this recipe
  routes over. Read its pool section first; everything here sits on top.
- [Recipe 66 — Evaluation inside the serving loop](66-eval-in-loop.md) for the
  `evaluation:` block — the in-loop judge whose verdict this recipe turns
  into an escalation.
- [Recipe 12 — Eval Harness](12-eval-harness.md) if you want to run the
  per-arm comparison at the end.

## TL;DR

From inside [`starters/hybrid-support/`](../starters/hybrid-support/README.md):

```bash
cd starters/hybrid-support

# the route, before you spend anything — offline, no key
bunx crewhaus models explain
bunx crewhaus models audit

# talk to it: easy turns take the cheap lane, failed drafts escalate
bunx crewhaus run crewhaus.yaml

# what actually happened
bunx crewhaus route explain <sessionId>
bunx crewhaus route status --by profile
```

## 1 — Declare each model once

A `models:` block is a registry of **profiles**: a name for everything
that can differ per model. It attaches to every shape, and any model slot
in the spec may reference a profile as `$<name>`.

```yaml
name: hybrid-support
target: cli

models:
  fast:
    model: claude-haiku-4-5
    tags: [cheap]
    max_tokens: 2048
    temperature: 0.2
    instructions: |
      You are the fast lane. Answer from the order notes you can read, in
      two sentences. If the notes do not settle it, say so plainly.
  strong:
    model: claude-opus-5
    tags: [strong]
    thinking: { effort: high }
  checker:
    model: claude-sonnet-5

agent:
  model: $fast
  instructions: |
    You answer customer questions about their orders.

tools: []
```

Three things to notice:

- **`$fast` is a lower-time macro, not a runtime lookup.** The compiler
  expands it into the fields the IR already had, so a spec with no
  `models:` block compiles byte-identically to 0.5.x.
- **`temperature` is new**, and it is mutually exclusive with `thinking`
  on one profile — the provider rejects the pair, so the spec does too.
- **A profile's `instructions` is an overlay**, not a replacement. On a
  serving slot it is folded in ahead of the agent's own instructions.

Quote the reference on any command line — `--models '$fast,$strong'` —
because an unquoted `$fast` is expanded away by the shell before the CLI
sees it.

## 2 — Give the cheap lane a smaller world

Two candidates make a pool. What is new is that a candidate carries every
profile field **inline**, which is where per-model narrowing lives:

```yaml
name: hybrid-support
target: cli

models:
  fast: { model: claude-haiku-4-5, tags: [cheap], max_tokens: 2048 }
  strong: { model: claude-opus-5, tags: [strong], thinking: { effort: high } }

agent:
  model: $fast
  instructions: |
    You answer customer questions about their orders.
  model_pool:
    policy: heuristic
    candidates:
      - model: $fast
        tools: [read, grep]
        permissions: { deny: ["Bash(**)"] }
        cost: { max_usd: 0.50 }
      - model: $strong

tools: [read, grep, bash]
```

- **`tools` is subset-only.** A candidate may narrow the shape's toolset,
  never extend it. `[]` means no shape tools at all.
- **`permissions` on a profile accepts `deny` and `ask` only.** There is
  no `alwaysAllow`, no `mode` — a lane can tighten what the shape allows
  and can never widen it. Note `Bash(**)`, not `Bash(*)`: a single star
  stops at `/`.
- **`cost.max_usd` is a per-lane cap inside one run.** When the lane has
  spent its share it becomes *ineligible* — routing moves on. It never
  ends the run; that is `budget:`.

**Where the narrowing may be declared is a real constraint.** Put `tools`,
`permissions`, `rate_limits`, `tool_config` or `cost` on a profile that
`agent.model` references, and the compiler refuses the spec: a
single-model serving slot has no per-candidate plan carrier, so a profile
declared narrower than the shape would quietly have served with the
shape's full toolset. The error says so, and tells you to move the
narrowing onto the candidate — which is what the block above does.

## 3 — Draft cheap, escalate on a failed grade

The cascade names two rungs by tag (or by `$profile`):

```yaml
name: hybrid-support
target: cli

models:
  fast: { model: claude-haiku-4-5, tags: [cheap], max_tokens: 2048 }
  strong: { model: claude-opus-5, tags: [strong], thinking: { effort: high } }
  checker: { model: claude-sonnet-5 }

agent:
  model: $fast
  instructions: |
    You answer customer questions about their orders. Name the order
    status, and cite the note you read it from.
  model_pool:
    policy: heuristic
    candidates:
      - model: $fast
        tools: [read, grep]
        permissions: { deny: ["Bash(**)"] }
      - model: $strong
    strategy:
      cascade: { draft: cheap, escalate_to: strong, clean_prompt: true }
      max_escalations: 1

tools: [read, grep, bash]

evaluation:
  grader:
    type: llm_judge
    model: $checker
    criteria: |
      The reply names the order's status and cites the note file it came
      from.
  threshold: 0.7
  on_fail: escalate
```

`on_fail: escalate` is the 0.6.0 addition to a block that already had
`retry`, `halt` and `note`. The difference matters: `retry` re-prompts the
model that just missed, with the judge's rationale appended. `escalate`
re-runs the turn on `strategy.cascade.escalate_to` — a *different* rung.
Declaring it without a `model_pool` is a spec error, because there would
be nothing to escalate to.

`clean_prompt: true` re-runs from the transcript as it stood **before** the
failed draft, so the strong model is not anchored on the answer that just
failed. `max_escalations` bounds the ladder.

The judge is metered. From 0.6.0 its spend rides the run bus with
`role: "judge"` and counts against `budget.usd`, under an explicit
`budget.judge_share` sub-cap — so "we added a checker" can no longer be an
invisible line on the bill.

## 4 — Read the route before you spend anything

Three offline verbs, no credential required:

```bash
crewhaus models list       # the resolved registry
crewhaus models explain    # every slot, the strategy, the per-shape verdict
crewhaus models audit      # pricing coverage + parameter acceptance
```

`models explain` is the one to keep open while you are writing the spec.
Against the starter it prints the whole route on one screen:

```
slots:
  agent.model                     claude-haiku-4-5 ← $fast  (max_tokens=2048 temperature=0.2)
  agent.model_pool.candidates[0]  claude-haiku-4-5 ← $fast  (max_tokens=2048 temperature=0.2)
  agent.model_pool.candidates[1]  claude-opus-5 ← $strong  (thinking=high)
  evaluation.grader.model         claude-sonnet-5 ← $checker

strategy:
  A heuristic pool of 2 arm(s) — claude-haiku-4-5 [cheap] / claude-opus-5 [strong] —
  picks the model per call, drafting on `cheap` and escalating to `strong` when the
  judge fails the draft. Quality does NOT reach the reward (`reward.quality_source: none`).
```

(the `strategy:` sentence prints on one line; it is wrapped here to fit.)

It ends with a **per-shape carry/emit/ignore table** for your own
`target:`, so a feature the shape does not carry is visible before you
build a demo around it — `committee`, for instance, is *not carried* on
`cli`, because in a REPL every turn is the one the user is waiting on.

`models audit` is the gate half. It walks the same slots and checks
pricing coverage, `requires:` against the capability table, and per-knob
parameter acceptance projected through each adapter's own marshaller — so
a `temperature` a provider would silently drop is visible offline. It
**exits 1** on a model already past its retirement date; `--fail-on none`
reports without failing, `--fail-on sunset` also fails on an announced
future one.

> `crewhaus doctor --models` walks the same slots now, but keeps its own
> contract: a warning never fails it, so a sunset that passes on a
> calendar day cannot redden a pinned `doctor` check. The gate lives in
> `models audit`, and `doctor` prints a line saying so.

## 5 — Prove what happened, per turn

Every decision is a durable `model_route` line, so the explanation is a
record rather than a reconstruction:

```bash
crewhaus route explain <sessionId>          # one run's timeline, turn by turn
crewhaus route explain <sessionId> --json   # the same timeline, machine-readable
crewhaus route status --by profile          # arms regrouped by profile
crewhaus route status --shadow              # include observe-only lanes
```

`route explain` is a **timeline**, not just a route table: alongside each
turn's decision (route key, arm, policy, reason, whether it was an
exploration) it replays the `/model` directives that were accepted or
refused, and the hybrid **stage transitions** — draft, grade, escalate —
with the model and cost of each. When a turn escalated, this is where you
see it, and why.

For the cost side, `cost-summary` and the Hangar fold spend by role and by
profile, so the judge, the draft and the escalation are separate numbers
rather than one total.

## 6 — Answer "is the cheap model good enough?" with a number

`eval --models` has run one matrix cell per model since 0.2.2. 0.6.0 adds
the two things that make the result usable: `--record` runs each cell
through the run-history flow so every arm keeps its **own** baseline
lineage, and a verb that reads the matrix honestly.

```bash
crewhaus eval crewhaus.yaml \
  --dataset eval/dataset.jsonl --graders eval/graders.yaml \
  --models '$fast,$strong' --record --seed 42

crewhaus eval leaderboard .crewhaus/evals/<matrix-dir>
```

The leaderboard ranks arms with a **paired sign-flip permutation test** on
the per-sample deltas (every cell ran the identical sample set),
Holm-corrected across comparisons, and it **refuses to name a winner it
cannot support**: `UNDERPOWERED` below the comparable-pair floor
(`--min-n`, default 30), `TIE` when the paired test is not significant or
the top two intervals overlap. Cells graded with a different graders hash
or judge model are excluded from the verdict rather than ranked beside
comparable ones.

The starter's six samples are deliberately below that floor, so the first
leaderboard you run against it says `UNDERPOWERED`. That is the honest
answer to a six-sample question, and seeing it once is worth more than a
leader you would have believed.

To route the eval the way production routes instead of pinning one arm per
cell, use `--routing as-declared` (mutually exclusive with `--models` — a
matrix already pins one arm per cell).

## 7 — The knobs this recipe left out

The pool block carries four more mechanisms, all opt-in and all off by
default:

| You want… | Reach for |
| --- | --- |
| A user to steer one message (`/model strong …`). | `model_pool.directives: true` |
| Deterministic routing from turn facts (images, length, channel). | `model_pool.rules` |
| A model to pick the lane from a constrained label set. | `policy: classifier` |
| The cheap model to ask the strong one mid-turn, or hand the turn over. | `strategy.model_directed: true` (registers `Consult` + `Escalate`) |
| An observe-only lane auditioning a challenger. | `strategy.shadow` |
| Graded quality to reach the learned reward, behind a floor. | `model_pool.reward.quality_source` |

`directives` is off on every shape on purpose. A `/model` line is parsed
only at the **typed input seams** — the REPL's own input and the
single-turn seed — never inside the router, so a `/model strong` that
arrives in a tool result, a recalled memory or an MCP response cannot
steer the route.

## Honest limitations

- **A bundle that wires the model-driven mechanisms needs
  `@crewhaus/model-service` from the registry.** `strategy.model_directed`,
  `policy: classifier` and the `guide` / `shadow` / `committee` side calls
  emit a runtime closure, so `compile … --check` cannot install a bundle
  that declares them until the package is published with the release. The
  cascade in this recipe needs none of them.
- **Per-model narrowing is a pool-candidate feature.** See §2 — a
  `$profile` carrying `tools` / `permissions` / `cost` on a single-model
  slot is refused, not silently ignored.
- **A judge panel is declared but not yet folded in-loop.** `judges:`,
  `repeats:` and a pinned judge `temperature` parse and lower; the in-loop
  judge site still calls the single model, and the compiler warns that the
  key is inert rather than pretending otherwise.
- **`route explain` needs a real session.** Everything in §4 is offline;
  §5 is not.
- **Six samples cannot rank two models.** That is the leaderboard's
  verdict, not a defect in it.

## When NOT to reach for this

- **When your traffic is uniformly hard.** A cascade that escalates every
  turn costs a draft *plus* the strong turn *plus* a judge call. Measure
  the split first (§6), then decide.
- **Before you have a judge you trust.** `on_fail: escalate` promotes the
  judge's verdict to a spending decision. If the rubric disagrees with
  humans, you have automated the disagreement —
  [Recipe 34](34-building-custom-graders.md) first.
- **To save money on a tool-less, single-turn shape.** There, a plain
  cheaper `agent.model` is the whole answer, and a pool is machinery you
  will maintain for nothing.

## What to read next

- **The pool, its policies, and the reward scoreboard.** [Recipe 59 — Model resilience & cost](59-model-resilience-and-cost.md).
- **The in-loop judge whose verdict escalates here.** [Recipe 66 — Evaluation inside the serving loop](66-eval-in-loop.md).
- **Turning the measurement into a shipped change.** [Recipe 42 — Active eval optimization](42-active-optimization.md) and [Recipe 57 — The advisor loop](57-advisor-loop.md).
- **Rolling a roster change out safely.** [Recipe 58 — Safe production ops](58-safe-production-ops.md).

## Pointers to source

- **Per-model plan + capability facts:** [`packages/model-plan`](https://github.com/crewhaus/factory/blob/main/packages/model-plan).
- **The composition root that wires hybrid closures:** [`packages/model-service`](https://github.com/crewhaus/factory/blob/main/packages/model-service).
- **Router and scoped arms:** [`packages/model-router`](https://github.com/crewhaus/factory/blob/main/packages/model-router), [`packages/routing-store`](https://github.com/crewhaus/factory/blob/main/packages/routing-store).
- **Consult / Escalate:** [`packages/tool-consult`](https://github.com/crewhaus/factory/blob/main/packages/tool-consult).
- **The leaderboard's statistics:** [`packages/eval-report`](https://github.com/crewhaus/factory/blob/main/packages/eval-report).
- **The starter:** [`starters/hybrid-support/`](../starters/hybrid-support/README.md).
- **Module catalog reference:** §17, §27 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
