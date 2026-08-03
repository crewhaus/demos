# Recipe 66 — Evaluation inside the serving loop

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `evaluation` (spec block), `eval-judge` (judge steps/nodes), `eval-grader` (grader registry), `runtime-core` (the in-loop scorer).
**Shipped:** crewhaus 0.4.0 (Batch B — `evaluation:` on cli/channel/managed, `kind: "judge"` workflow steps + graph nodes, `eval --repeats` for pass^k); extended in 0.4.x (judge abstention in-loop, `eval_graded`/`judge_verdict` OTel spans, the `eval-fail` mining signal in `dataset mine`, `feedback:` on `target: managed`).

Every other eval recipe in this series scores the agent **offline** — after a
run, over a dataset, on your machine or in CI ([Recipe 12 — Eval
Harness](12-eval-harness.md), [Recipe 56 — Flywheel](56-self-improvement-flywheel.md),
[Recipe 61 — Self-building evals](61-self-building-evals.md)). That's the right
place to *learn*. But it does nothing for the reply a user is about to read
**right now**. The 0.4.0 loop contract closes that gap: a judge sits **inside
the serving loop**, scores each finished answer before it ships, and can quietly
re-prompt the model until the answer clears a quality floor.

Two surfaces, same idea:

- **`evaluation:`** — an in-loop grader on the interactive shapes (`cli`,
  `channel`, `managed`). Scores every completed assistant turn; retries, halts,
  or just notes when it falls below threshold.
- **`kind: "judge"` steps/nodes** — a gate on a `workflow` step or `graph` node
  that scores the *previous* step's output and can re-run it with the judge's
  rationale as feedback.

You'd reach for this when:

- A wrong-but-confident answer is worse than a slow one, and you want the model
  to **catch itself** before the user sees it.
- A pipeline step's output feeds a downstream step, and you want to **gate the
  handoff** rather than propagate a bad intermediate.
- You want a quality floor that shows up in the **trace and the exit code**, not
  just a dashboard you check tomorrow.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) for the offline scoring model
  this mirrors in-loop — the `llm_judge` grader is the same idea, moved inside
  the run.
- [Recipe 53 — Justification gates](53-justification-gates.md) for the classified
  `run_failed` machinery a below-threshold `halt` reuses (this one adds exit code
  35, the quality floor, beside the budget cap's 33 and the timers' 34).

## Part 1 — `evaluation:` on a cli agent

Add an `evaluation:` block to any `cli`/`channel`/`managed` spec. The grader is
one of three kinds — a model-scored `llm_judge`, or the deterministic `contains`
/ `regex` text checks:

```yaml
# support-agent.yaml
name: support-agent
target: cli
agent:
  model: claude-sonnet-5
  instructions: >
    Answer the customer's billing question. Always cite the specific policy
    section, and never promise a refund you haven't confirmed.

evaluation:
  grader:
    type: llm_judge
    criteria: >
      The reply cites a concrete policy section and makes no unconfirmed
      refund promise. A vague or hedging answer fails.
    model: cheapest          # optional; defaults to the shape's primary model
  threshold: 0.75            # llm_judge only; default 0.7
  on_fail: retry             # retry (default) | halt | note
  max_retries: 2             # default 1, capped at 5
```

Run it exactly as any other cli spec — the gate is wired by `crewhaus run`:

```bash
crewhaus run support-agent.yaml
```

After each completed assistant turn the runtime scores the final text. What
happens next is `on_fail`:

- **`retry`** (default) — re-prompt the model with the judge's rationale
  appended as a correction nudge, at most `max_retries` times. When the budget
  is spent, the last attempt stands (the failing trail tells the story).
- **`halt`** — abort the turn with a classified failure: `run_failed`, class
  `"evaluation"`, **exit code 35**. Use this when shipping a bad answer is worse
  than shipping nothing.
- **`note`** — score and emit a trace event only; never blocks the reply.
  Instrument first, enforce later.

Every scoring pass publishes an `eval_graded` trace event, so the retry loop is
visible in the structured event stream:

```
eval_graded  grader=llm_judge score=0.55 threshold=0.75 verdict=fail retry=0
eval_graded  grader=llm_judge score=0.82 threshold=0.75 verdict=pass retry=1
```

### An abstaining judge scores 0

The offline `llm_judge` grader can **abstain** when the evidence is
insufficient to score honestly. In-loop, an abstention is treated as
**score 0** with a `judge abstained: …` rationale on all three shapes —
so a guessed best-estimate can never clear the threshold. This is the
in-loop counterpart of the offline needs-human bucket
([Recipe 12 §The five buckets](12-eval-harness.md#the-five-result-buckets)),
and the asymmetry is deliberate: offline you can afford to set a sample
aside for a human; in the serving loop there is a reply about to ship,
and the conservative reading is the only safe one.

### A failed in-loop verdict is a mining signal

`crewhaus dataset mine --sessions all --review` harvests turns whose
in-loop judge failed, reading them from the session's **trace sidecar**
`<id>.events.jsonl` (the durable event log carries no `eval_graded`
kind; both flat and enveloped carriers are accepted). There is no
per-signal selector — `mine` always scans the full union, and `eval-fail`
is one of its signal *values*.

**The `eval-fail` signal is opt-in.** The trace sidecar is written only
when the run had `CREWHAUS_WATCHME=1` set, so `evaluation:` alone is not
enough: a compiled `cli` or `channel` bundle stamps that env only when
the spec also carries a `watchme:` block with `enabled: true` and
`capture: full`; `crewhaus run` stamps it for that case plus after a
`crewhaus watchme start`; the managed daemon does not stamp it yet. A
harness with the judge wired and watchme off yields **zero** `eval-fail`
candidates — which is why `dataset mine` prints how many scanned
sessions carried a sidecar, and names the env var when none did.

The retry ladder is respected: a turn `on_fail: retry` **recovered** is
**not** harvested — it worked. A turn that burned the ladder and still
failed is flagged `eval_retries_exhausted`, ranks just below `error` in
dedupe, and carries the judge score, threshold and grader into the
quarantine sample's metadata. That is how a quality floor in production
becomes a hard case in your offline dataset
([Recipe 61](61-self-building-evals.md#grow-the-dataset-from-real-usage)).

### Grader kinds at a glance

| `grader.type` | Scores | `threshold`? | Model spend |
| ------------- | ------ | ------------ | ----------- |
| `llm_judge`   | model rates the final text in [0,1] against `criteria` | yes (default 0.7) | judge calls **metered into the run budget** |
| `contains`    | pass iff final text contains `value` (case-sensitive) | no | none |
| `regex`       | pass iff final text matches the JS regex `value` | no | none |

Two rules the strict schema enforces at build time (a typo'd sub-key or a
misplaced `threshold` fails `compile`):

- **`threshold` is `llm_judge`-only.** Declaring it alongside a `contains` /
  `regex` grader is a parse error — those are deterministic pass/fail, nothing to
  threshold.
- **The judge model defaults to the shape's primary model.** Pass an explicit
  `model`, or the `cheapest` sentinel (resolves at compile time like
  `compaction.model`) to score with a cheap model while the agent runs on an
  expensive one — the usual generator≠judge hygiene from [Recipe 53](53-justification-gates.md).

### What the optimizer can touch

`evaluation.threshold` and `evaluation.max_retries` are in `OPTIMIZABLE_PATHS`
on all three shapes — `crewhaus optimize` can tune the quality floor and the
retry budget against your eval set. The **grader itself is deliberately not
optimizer-reachable**: the optimizer can't relax the criteria it's being graded
against.

## Part 2 — a workflow judge step gating the previous step

On a `workflow`, a `kind: "judge"` step gates the step **before** it. It runs no
agent turn of its own — it only scores the previous step's final output and
decides whether the pipeline proceeds:

```yaml
# draft-and-check.yaml
name: draft-and-check
target: workflow
model: claude-sonnet-5
steps:
  - name: draft
    instructions: >
      Draft the release note for the changes in $CHANGES. Keep it under
      120 words and lead with the user-facing benefit.

  - name: quality-gate
    kind: judge
    judge:
      criteria: >
        The draft is under 120 words, leads with a user-facing benefit,
        and names no unreleased feature. Marketing fluff fails.
      threshold: 0.8
      on_fail: retry_previous   # retry_previous (default) | halt | continue
      max_retries: 2
      model: cheapest

  - name: publish
    instructions: Format the approved draft as markdown ready for the blog.
```

Compile and run it like any workflow:

```bash
crewhaus compile draft-and-check.yaml
crewhaus run draft-and-check.yaml
```

The judge step's `on_fail` mirrors the in-loop block, tuned for a pipeline:

- **`retry_previous`** (default) — re-run the gated step (`draft`) with the
  judge's rationale appended as a nudge, at most `max_retries` times.
- **`halt`** — abort the run classified (`run_failed`, class `"evaluation"`,
  exit 35), same as the cli block.
- **`continue`** — record the verdict and proceed anyway.

Each scoring pass publishes a `judge_verdict` trace event (both `eval_graded`
and `judge_verdict` ship pretty renderers in the structured event printer):

```
judge_verdict  at=quality-gate verdict=fail score=0.62
judge_verdict  at=quality-gate verdict=pass score=0.87
```

### Both events are first-class telemetry now

`eval_graded` and `judge_verdict` emit **OTel spans**
(`eval_graded.<verdict>` / `judge_verdict.<verdict>`, with typed
`crewhaus.eval.*` / `crewhaus.judge.*` attributes and **ERROR status on
a failing verdict**), and fold into the metrics
`crewhaus_eval_verdicts_total{source,verdict}` and
`crewhaus_eval_score{source}`. The `source` label is `in_loop` /
`judge_step` / `eval_sample`, so one dashboard can trend live quality
beside the last gated offline run without confusing the two.

**State the boundary, because it's the part that bites:**
`attachDefaultSubscribers` attaches only the printer, the metrics
collector and the generic OTLP exporter — a `DD_API_KEY` alone exports
nothing, you still need the OTLP endpoint wired
([Recipe 17](17-observability.md)). And there is **no quality-drop alert
in `alert-watchdog`**: the metric exists, the alert on it is yours to
define.

Constraints the schema pins: a judge step **can't be the first step** (there's
no previous output to gate), and it carries **only the gate config** — no
`instructions`, no `tools`. The identical `kind: "judge"` node exists on the
`graph` shape, gating an upstream node instead of the previous step (a graph
*source* node likewise can't be a judge — enforced in `parseSpec`).

## Note — pass^k and the grader registry

Two adjacent offline knobs pair naturally with in-loop evaluation:

- **`eval --repeats K` (pass^k).** In-loop `retry` masks flakiness from the
  user; `eval --repeats` **measures** it. Every sample runs K times, and the
  aggregate reports both `pass@K` (at least one trial passed — the optimistic
  capability metric) and `pass^K` (ALL K passed — tau-bench's reliability
  metric; a flaky 60%-reliable agent scores 0.6^K). Trials run sequentially in
  each sample's concurrency slot, so a K-repeat run costs ~K× the wall clock and
  spend — `tokens_all_trials` in the summary makes that visible.

  ```bash
  crewhaus eval support-agent.yaml --dataset eval/dataset.jsonl \
    --graders eval/graders.yaml --repeats 3 --seed 7
  # → [eval] repeats=3: pass@3=66.7% pass^3=33.3% tokens_all_trials=…
  ```

- **The reachable grader registry.** Offline `graders.yaml` entries of `type:
  registry` resolve against the default grader registry — **eight** namespaces
  (`continuity.*`, `twelve.*`, `nlg.*`, `semantic.similarity`, `multimodal.*`,
  `safety.*`, `calibration.*`, `consistency.*`) plus any `.crewhaus/graders`
  plugins, which win on name collisions. Entries may carry `opts:`, validated
  **per pack at run start** — an unknown key is a loud error naming that pack's
  accepted vocabulary. That's how the offline harness reaches graders the
  in-loop `evaluation.grader` (deliberately just `llm_judge`/`contains`/`regex`)
  does not — the in-loop grader stays small and hot; the registry is for the
  deep offline rubric ([Recipe 12 §Registry graders](12-eval-harness.md#registry-graders-packs-and-plugins)).

- **`run_exam` accepts `type: registry` too.** A spec-declared
  `learning.exam.graders` file used to reject registry entries; it now builds
  the **same** default registry `crewhaus eval` falls back to (the eight
  namespaces plus `.crewhaus/graders` plugins from the harness cwd, `opts:`
  included), and an unknown name fails loudly at exam start. A living
  competency exam is no longer judge-only.

## When to NOT reach for this

- **For a raw latency-sensitive path.** `retry` re-runs the model turn; an
  `llm_judge` grader adds a scoring call on top. If milliseconds matter more than
  the occasional weak answer, score offline instead.
- **As your only quality signal.** In-loop evaluation catches *this* answer; it
  learns nothing. Keep the offline harness ([Recipe 61](61-self-building-evals.md))
  and the flywheel ([Recipe 56](56-self-improvement-flywheel.md)) — the in-loop
  gate is the last line, not the whole defense.
- **With `on_fail: halt` before you've watched it in `note` mode.** A too-strict
  `threshold` will start failing runs classified. Ship `note` first, read the
  `eval_graded` scores, then tighten.

## What to read next

- **The offline scoring this mirrors.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Graders beyond the three in-loop kinds.** [Recipe 34 — Building custom graders](34-building-custom-graders.md).
- **The classified-failure + exit-code machinery `halt` reuses.** [Recipe 53 — Justification gates](53-justification-gates.md).
- **Where the in-loop failures you mine end up.** [Recipe 61 — Self-building evals](61-self-building-evals.md) and [Recipe 74 — Eval suites, cassettes, red teams](74-eval-suites-and-cassettes.md).

## Pointers to source

- **Spec grammar:** `evaluationBlock` / `evaluationGraderSchema` / `judgeGateBlock` in [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts).
- **In-loop scorer + `eval_graded`:** [`packages/runtime-core/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/runtime-core/src/index.ts) (search `evaluation`).
- **Judge steps/nodes:** [`@crewhaus/eval-judge`](https://github.com/crewhaus/factory/blob/main/packages/eval-judge).
- **Grader registry (`type: registry`):** [`packages/eval-grader/src/graders-config.ts`](https://github.com/crewhaus/factory/blob/main/packages/eval-grader/src/graders-config.ts).
- **pass^k output:** [`apps/cli/src/eval-output.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/eval-output.ts).
