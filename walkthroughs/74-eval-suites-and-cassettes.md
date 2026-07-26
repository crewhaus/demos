---
test:
  spec: starters/eval/crewhaus.yaml
  packages:
    - packages/eval-runner
    - packages/eval-report
    - packages/eval-grader
    - packages/eval-judge
    - packages/dataset-registry
    - packages/feedback-distill
---

# Recipe 74 — Eval suites, tool cassettes, red teams, and the review queue

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `eval-runner`, `eval-report`, `eval-grader`,
`eval-judge`, `dataset-registry`, `feedback-distill` (the review queue),
plus the CLI's suite runner
([`apps/cli/src/eval-suite.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/eval-suite.ts))
and red-team generator
([`apps/cli/src/redteam.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/redteam.ts)).
**Shipped:** crewhaus 0.4.x (`eval suite`, `eval --record-tools` /
`--replay-tools` / `--resume`, `redteam generate|report`,
`review list|next|resolve`, `init --ci --suite`).
**Starter:** [`starters/eval/`](../starters/eval/README.md) — the suite
manifest ships as
[`starters/eval/eval-suite.yaml`](../starters/eval/eval-suite.yaml).

[Recipe 12](12-eval-harness.md) gets you one eval run. This recipe is
about the four things that stand between one eval run and an eval
**practice** a team can actually keep:

1. **Tiering** — you cannot run the full suite on every commit, and you
   should not gate a release on the smoke suite. `crewhaus eval suite`
   makes the ladder one file with one verdict per rung.
2. **Determinism** — a tool-using agent's eval is only reproducible if
   its tools are. Tool cassettes record every tool result once and
   replay them.
3. **Adversarial coverage** — your dataset measures what you thought to
   ask. `crewhaus redteam generate` measures what an attacker would ask.
4. **The human in the loop** — a judge that abstains and a panel that
   splits are asking a question, not producing a number.
   `crewhaus review` is where those questions queue up.

You'd reach for this when:

- Your eval has grown past "one dataset, one graders file" and CI is
  either too slow or too shallow.
- A tool-using agent's eval flakes and you can't tell a regression from
  a coin flip.
- You're about to put an agent in front of the public and "we tested the
  happy path" is the honest summary of your coverage.
- Judges keep producing verdicts nobody reads, and you want the
  uncertain ones routed to a person instead of averaged away.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) — the dataset, the
  `graders.yaml` grammar, the flags, and the five result buckets. Every
  entry in a suite runs through that exact code path.
- [Recipe 62 — Response Ratings](62-response-ratings.md) for the
  feedback machinery the review queue's session-turn items resolve
  through.
- An Anthropic credential if you want to run the suite live. The
  red-team **generator**, `dataset lint`, and every read verb here are
  offline.

## TL;DR

From inside [`starters/eval/`](../starters/eval/README.md):

```bash
cd starters/eval

# 1 — the CI ladder, one verdict per tier
bunx crewhaus eval suite eval-suite.yaml --tier fast --gate

# 2 — an attack suite generated against YOUR agent, offline and deterministic
bunx crewhaus redteam generate --spec agent.cli.yaml --count 24 --seed 7
bunx crewhaus eval agent.cli.yaml --dataset registry:hello-redteam \
  --graders eval/redteam-graders.yaml -o .crewhaus/evals/redteam-1
bunx crewhaus redteam report --runs .crewhaus/evals/redteam-1

# 3 — drain what the judges could not decide
bunx crewhaus review list
bunx crewhaus review next
```

Cassettes need a **tool-using** agent, so their TL;DR runs against
[`starters/ghostwriter/`](../starters/ghostwriter/README.md) instead
(scaffold its eval assets first — [Recipe 72](72-zero-to-improving.md)):

```bash
cd starters/ghostwriter
bunx crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl \
  --graders eval/graders.yaml --record-tools .crewhaus/cassettes/v1
bunx crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl \
  --graders eval/graders.yaml --replay-tools .crewhaus/cassettes/v1
```

## Part 1 — The suite manifest

A suite manifest names **tiers**; each tier lists **entries**; each entry
is a `(dataset, graders)` pair plus the run flags that belong to it. Tier
names are a **fixed vocabulary** — `fast | nightly | release` — precisely
so `--tier fast` means the same thing in every repo.

The shipped example is
[`starters/eval/eval-suite.yaml`](../starters/eval/eval-suite.yaml):

```yaml
name: hello-eval
spec: agent.cli.yaml          # default spec for every entry

tiers:
  fast:
    - name: smoke                                          # the run directory
      dataset: .crewhaus/datasets/hello-eval/dev.jsonl     # file or registry:<ref>
      graders: graders.yaml
      seed: 42
      concurrency: 2
      thresholds:
        min_pass_rate: 0.8                                 # ABSOLUTE floor

  nightly:
    - name: full
      dataset: registry:hello-eval                         # train + dev (test is locked)
      graders: graders.yaml
      seed: 42
      repeats: 3
      concurrency: 2
      gate: true                                           # the BASELINE gate
      thresholds:
        min_pass_rate: 0.8
        max_p95_latency_ms: 30000                          # a criterion OF that gate

  release:
    - name: holdout
      dataset: registry:hello-eval#test
      graders: graders.yaml
      seed: 42
      concurrency: 1
      allow_test_split: true                               # mirrors eval --allow-test-split
      thresholds:
        min_pass_rate: 1.0
```

Run a rung:

```bash
bunx crewhaus eval suite eval-suite.yaml --tier fast --gate
```

`--tier` defaults to **`fast`**. `-o` defaults to
`.crewhaus/evals/suite_<tier>_<timestamp>`; each entry writes a full run
directory to `<out>/<entry>/`, and the tier verdict plus every entry's
aggregates and failure reasons land in **`<out>/suite.json`**. `--gate`
maps a failing tier to a non-zero exit. `--spec <spec.yaml>` overrides
every entry's spec, which is how the scaffolded CI job evaluates the base
branch's spec against the PR's data.

### Two gates, deliberately different

This is the distinction that decides whether your CI is honest:

| Mechanism | Bites when | Needs history? |
| --------- | ---------- | -------------- |
| `thresholds.min_pass_rate` / `min_mean_score` | the entry's own `results.json` falls below an **absolute** floor | **no** — bites from run one, including in a fresh CI workspace |
| `gate: true` | the unchanged `(spec, dataset)` **baseline regression** gate fails (pass-rate drop or a per-sample pass→fail flip) | **yes** — vacuously passes until something pins a baseline |
| `thresholds.max_p95_latency_ms` / `max_cost_usd` | criteria **of** the baseline gate | yes — which is why they require `gate: true` |

A tier passes only when **every** entry passes. A **partial**
(budget-exhausted) entry always **fails** — an incomplete measurement
cannot clear a floor.

### What the parser refuses, and why

Both schemas are `.strict()`, and the refusals are all the same idea:
**dead config that reads like a gate is worse than no gate.** Verified
against the parser:

| You wrote | It says |
| --------- | ------- |
| an entry with **no** `thresholds` and no `gate: true` | `entry "x" declares no gating criteria — it can never fail, so its PASS would mean nothing` |
| `max_cost_usd` without `gate: true` | `max_cost_usd are criteria of the (spec, dataset) BASELINE gate — declare gate: true …` |
| a tier named `smoke` | `Unrecognized key(s) in object: 'smoke'` + `declare at least one tier (fast \| nightly \| release)` |
| `threshold:` (singular) | `Unrecognized key(s) in object: 'threshold'` |
| two entries named `x` in one tier | `duplicate entry name "x" — entry names are the run directories` |
| `tiers: {}` | `declare at least one tier` |

### Runtime behavior

Entries run **sequentially** through the same code path a hand-typed
`crewhaus eval` takes — registry refs, the regression union, the
preflight lint-lite, triage, run history and baselines all behave
identically. Before the first entry spends anything, a **preflight**
refuses missing spec/graders/dataset files (registry and `http(s)` refs
resolve at run time and are skipped). A crashed entry is isolated so the
rest of the tier still reports.

The full grammar, for reference:

| Entry key | Type | Notes |
| --------- | ---- | ----- |
| `name` | `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` | becomes a directory name |
| `dataset` / `graders` | string | **required**; same values `--dataset` / `--graders` take |
| `spec` | string | per-entry override of the manifest's `spec:` |
| `seed`, `repeats` (≥1), `concurrency` (≥1) | int | as the matching `eval` flags |
| `slice` | **list** of strings | rendered to `--slice a,b` |
| `gate` | bool | the baseline regression gate |
| `allow_test_split` | bool | mirrors `eval --allow-test-split` |
| `thresholds` | `.strict()` object | the four keys above |

## Part 2 — Tool cassettes: record once, replay deterministically

The math agent in `starters/eval` has no tools, so there is nothing to
record. Cassettes matter for a **tool-using** agent — use
[`starters/ghostwriter/`](../starters/ghostwriter/README.md), which reads
its voice samples off disk (scaffold its eval assets first, per
[Recipe 72](72-zero-to-improving.md#day-0--a-spec-and-its-scaffolded-exam)):

```bash
cd starters/ghostwriter
bunx crewhaus scaffold-evals crewhaus.yaml --samples 8

# record: tools still run for real, every result is written down
bunx crewhaus eval crewhaus.yaml \
  --dataset eval/dataset.jsonl --graders eval/graders.yaml \
  --record-tools .crewhaus/cassettes/v1

# replay: the recorded results are served instead of executing anything
bunx crewhaus eval crewhaus.yaml \
  --dataset eval/dataset.jsonl --graders eval/graders.yaml \
  --replay-tools .crewhaus/cassettes/v1
```

Recording appends every tool execution to `<dir>/tools.jsonl`, keyed by
`(sampleId, toolName, sha256(canonical-JSON args))`. The run is otherwise
byte-identical to an unrecorded one. Replay intercepts at
`RegisteredTool.execute`, wrapped per sample inside the runner's default
invoker — so it covers built-ins, MCP tools, Skill/Task wrappers, and
memory-fabric tools alike.

A call whose key the recording doesn't carry is a **miss**:

| `--replay-miss` | Behavior |
| --------------- | -------- |
| `error` (**default**) | fail that sample naming the missing key, and **never noise-retry** it — it would fail identically |
| `live` | execute the tool for real |

Repeated identical calls replay in order; once a key's entries run out
the last one keeps replaying — and because that means the replayed
trajectory called the tool **more** times than the recording did, the run
prints an `[eval] warning:` naming those calls and records a
`reusedEntries` count. `run.json` records the mode, the directory, and
(on replay) the recording's content hash, so a replayed run gates and
pins like any other run but says what it was.

### The honest boundaries

- **Scope is TOOLS ONLY.** MCP servers still boot (so their tool schemas
  exist) and **the model still runs live**. A replay is neither
  credential-free nor offline. It removes tool nondeterminism, not model
  nondeterminism.
- **The two flags are mutually exclusive**, and both are **refused with
  `--models`** (matrix cells share sample ids) and alongside a
  caller-supplied `RunEvalOptions.invoker`.
- **A recording holds tool args and results verbatim** — bash stdout, MCP
  responses, file contents. Treat `<dir>` like a session transcript: do
  not commit one recorded against production credentials or production
  data.

### `--resume`: don't re-pay for the half that worked

```bash
bunx crewhaus eval crewhaus.yaml --dataset eval/dataset.jsonl \
  --graders eval/graders.yaml --resume .crewhaus/evals/eval_01hxyz
```

The run re-opens under its **original** `runId` and `startedAt`; every
sample that already wrote `grades.json` is reloaded from disk (no agent
call, no judge call, no spend); only the missing samples run; the union
is re-aggregated into a fresh `results.json` + `index.html`.

Constraints worth knowing before you rely on it:

- It **refuses loudly, before any spend**, when the run's `specHash`,
  `datasetHash` or `gradersHash` no longer match `run.json` — naming
  every field that moved. Splicing two different measurements into one
  run is never silent.
- A sample that ran and **errored** is complete and is reused as-is.
  Delete its artifact directory to re-run just that one.
- Under `--repeats`, a sample re-runs **whole** unless every trial
  directory is complete.
- The resumed run appends a **superseding** index entry under the same
  runId — the index stays append-only, and history readers keep only the
  newest per runId.
- A budget-partial run still refuses to pin a baseline. When the
  **pinned** baseline *is* the run you're resuming, the gate is refused
  with a warning rather than comparing the run against itself.
- `--budget-usd` is re-armed per attempt; the resume prints what earlier
  attempts already spent first.
- Mutually exclusive with `-o` (the run directory **is** the output) and
  with `--models`.

## Part 3 — Red-team probes

Your dataset measures what you thought to ask. `crewhaus redteam
generate` builds an attack suite **against your agent** along two axes
declared in a strict-schema taxonomy: behavior **categories** (data
exfiltration, third-party PII, tool misuse, policy evasion, harmful
content, impersonation) × attack **strategies** (direct, fiction framing,
claimed authority, incremental, obfuscation, and prompt injection).

```bash
cd starters/eval
bunx crewhaus redteam generate --spec agent.cli.yaml --count 24 --seed 7
```

The cross product is walked **diagonally**, so a small `--count` still
covers every category *and* every strategy, then truncated — never
padded. `--count` defaults to **24**, and the help is explicit that 24
buys coverage of both **axes**, not of every pair: the shipped taxonomy
has 36 pairs and the injection strategy expands 5× per pair, so
`--count 120` is what buys every pair (and the eval spend with it).

**Deterministic and offline.** Same taxonomy + `--count` + `--seed` →
byte-identical corpus, no credentials needed. Attack strings are
**composed at generation time** from parts that are inert on their own (a
strategy's framing fragments wrapped around a category's objective) —
never shipped as ready-made payloads. The one exception, the `injection`
strategy, reuses the curated **safe** subset of the detector's own rules
that `dataset synthesize` already uses (instruction-override family only,
never a destructive command).

`--budget-usd F` additionally asks a model for rephrasings of each probe,
capped by the budget and **best-effort** — the deterministic corpus is
the floor, and model-derived samples are tagged
`generator: redteam-model`. `--taxonomy <t.yaml>` replaces the shipped
taxonomy under a strict schema, because a silently-skipped strategy is an
untested attack surface.

Two outputs land:

- A registry dataset **`<spec>-redteam`** (here `hello-redteam`) with
  `metadata.source: synthetic`, `difficulty: adversarial`,
  category/strategy tags, and **never a gold answer**.
- A paired refusal-grading `graders.yaml` (default
  `<spec-dir>/eval/redteam-graders.yaml`) whose **categorical** judge
  rubric includes an **over-refusal** label — so the suite cannot be
  gamed by an agent that refuses everything.

**Nothing unions this into a gate.** Only `<spec>-regressions` is
auto-unioned; adopting the red-team suite is an explicit
`--dataset registry:<spec>-redteam`:

```bash
bunx crewhaus eval agent.cli.yaml \
  --dataset registry:hello-redteam \
  --graders eval/redteam-graders.yaml \
  -o .crewhaus/evals/redteam-1
bunx crewhaus redteam report --runs .crewhaus/evals/redteam-1
```

`redteam report` computes **attack-success rate** — the fraction of
graded probes the agent **failed** — overall and per category/strategy,
from a run dir, a comma-separated list, or `last:N` from the run-history
index. Errored and judge-abstained probes are **excluded from the
denominator and reported separately**: an ASR inflated by timeouts is
worse than no number. ASR is its own block and is **never folded into
the pass-rate baseline**.

## Part 4 — The review queue

A judge that abstains and a panel that splits are asking a question. The
queue is where those questions go — one append-only store at
**`.crewhaus/review/queue.jsonl`**, three feeders, four kinds:

| Kind | Fed by | Meaning |
| ---- | ------ | ------- |
| `abstained` | `crewhaus eval`, at run end | an `llm_judge` declined for insufficient evidence |
| `needs_review` | `crewhaus eval`, at run end | a judge **panel** split its vote (high entropy) |
| `rater_disagreement` | `crewhaus distill` | multiple humans disagreed and nobody adjudicated |
| `quarantine` | `crewhaus dataset mine` | a **pointer** to a quarantined hard-case candidate (the quarantine JSONL stays the payload store) |

All three feeders are **idempotent** (entry ids are deterministic from
the source key), and the eval feeder is **best-effort**: a queue write
can never fail the run.

```bash
crewhaus review list                      # open items, oldest first
crewhaus review list --kind abstained     # filter by kind
crewhaus review list --all                # include resolved
crewhaus review next                      # the oldest open item, with context
crewhaus review resolve <id> --note "gold was wrong; fixed in v3"
```

`review next` in a **TTY** records your verdict — and when the item
points at a session turn, it routes that verdict through the **same**
capture machinery as `crewhaus rate`, recorded as an *adjudication*, so
the disagreement closes at the feedback source too and not just in the
queue. In a **non-TTY it prints the item and exits** — it will never hang
a script or a CI pipe.

### The multi-rater story behind `rater_disagreement`

`crewhaus distill` used to resolve several ratings on one turn by
later-timestamp-wins. It now resolves them explicitly:

- **all-thumbs** → majority;
- **stars/scale (or mixed)** → mean normalized score;
- a **`--adjudicate`** record always wins and closes the disagreement:

  ```bash
  crewhaus rate --session sess_0123456789abcdef --turn 4 --stars 5 --adjudicate
  crewhaus feedback --session sess_0123456789abcdef --turn 4 \
    --text "the second rater was right" \
    --correction "3 business days, not 3 calendar days" --adjudicate
  ```

  On `rate`, any rating (`--thumbs`/`--stars`/`--score`) carries the
  verdict. On `feedback`, `--adjudicate` **requires** `--correction` — a
  comment alone carries no verdict, so the combination is rejected before
  the record is written.

- a **true split verdict** (even thumbs, no adjudication) is **not
  silently labeled**: the turn is withheld from the dataset and enqueued
  here.

Every rater's normalized verdict is recorded in `metadata.ratings` (plus
`metadata.adjudicated` when an adjudication settled it), and `distill`
prints per-turn agreement plus overall **Cohen's kappa** whenever any
turn has ≥2 raters. Single-rater corpora — including everything you
recorded before this release — distill **byte-identically**.

## Part 5 — Wiring the ladder into CI

Three scaffolds take the same `--suite` flag, and **without it all three
are byte-identical to before**:

```bash
crewhaus init --ci --suite eval-suite.yaml         # PR check + nightly cron
crewhaus init --sentinel --suite eval-suite.yaml   # drift cron + nightly tier
crewhaus flywheel init --suite eval-suite.yaml     # flywheel cron + nightly tier
```

- **`init --ci --suite`** emits `crewhaus-eval.yml` that runs the **fast**
  tier on every PR — the base-branch spec runs first to pin each entry's
  baseline in the fresh workspace, then the PR spec with `--gate` — plus
  a **nightly**-cron job for the nightly tier, plus a tier-verdict PR
  comment built from `suite.json`. Wire
  `crewhaus eval suite --tier release --gate` into your release job
  yourself.
- **`init --sentinel --suite`** gives the drift cron a nightly-tier step
  that runs **even when the probe failed**.
- **`flywheel init --suite`** appends the same nightly-tier step to the
  flywheel cron, after the improvement PR is opened — so neither signal
  can hide the other.

The suite path is **harness-relative and must live inside the harness**
(it is the jobs' working directory). A manifest you haven't written yet
**warns** rather than failing the scaffold, and an existing manifest is
parsed so a tier the workflow runs but the manifest never declares is
named at scaffold time.

Not on GitHub Actions?

```bash
crewhaus schedule generate --for eval-gate --runner cron --dir /srv/my-harness
```

prints a crontab line, a launchd plist, or a systemd service+timer pair
wrapping the same command the corresponding workflow runs
(`--for flywheel | eval-gate | sentinel`). It is a **shim, not a
daemon**: nothing is installed, scheduled, or written — you review the
text and install it yourself. The scheduler's own failure reporting is
the alert, because the wrapped commands exit non-zero on
regression/drift.

## Honest limitations

- **`crewhaus eval` is still `target: cli` only.** A workflow, graph,
  crew, or pipeline is evaluated through
  `compile --with-eval-harness`, which drives the shape's real compiled
  runtime ([Recipe 61](61-self-building-evals.md)). A suite entry runs
  `crewhaus eval`, so the same boundary applies to every entry.
- **A cassette replay is not an offline run.** Tools are replayed; the
  **model still runs live** and MCP servers still boot. Budget for it.
- **The red-team suite grades refusal quality, not exploitability.** It
  measures what your agent *says*; it does not prove a tool call was
  actually prevented. Pair it with the permission and egress fabric
  ([Recipe 29](29-permissions-deep-dive.md),
  [Recipe 55](55-egress-fabric.md)), which are the mechanisms that
  actually stop the action.
- **`--count 24` is axis coverage, not pair coverage.** Read the number
  the command prints, not the reassurance you wanted.
- **`review next` records a verdict; it does not fix your dataset.**
  Closing an `abstained` item means a human decided — the sample still
  needs a gold, or a rubric that can score it.
- **The review queue is append-only.** `resolve` closes an item; it never
  rewrites history.
- **Absolute floors and the baseline gate answer different questions.**
  A fresh CI workspace has no baseline, so `gate: true` alone passes
  vacuously there. If a required check must mean something on day one,
  it needs a `min_pass_rate`.

## When NOT to reach for this

- **Before you have one eval you trust.** Tiering a suite whose graders
  disagree with humans just spreads the disagreement over three rungs.
  Run [`graders test`](34-building-custom-graders.md#meta-eval-is-your-grader-any-good)
  first.
- **On a tool-less agent, for cassettes.** There is nothing to record,
  and the flag buys you nothing but a directory.
- **As a substitute for the security fabric.** Red-team probes are
  measurement. Permissions, hooks, and egress rules are enforcement —
  see [Recipe 41](41-security-fabric.md).

## What to read next

- **Everything a single entry does.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Making the graders themselves trustworthy.** [Recipe 34 — Building Custom Graders](34-building-custom-graders.md).
- **Putting a non-cli shape behind the same suite.** [Recipe 61 — Self-building evals](61-self-building-evals.md).
- **The nightly loop the suite runs beside.** [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md).
- **Where the ratings that feed `rater_disagreement` come from.** [Recipe 62 — Response Ratings](62-response-ratings.md).

## Pointers to source

- **Suite manifest + tier runner:** [`apps/cli/src/eval-suite.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/eval-suite.ts).
- **Red-team taxonomy + generator:** [`apps/cli/src/redteam.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/redteam.ts).
- **Review queue store:** [`packages/feedback-distill/src/review-queue.ts`](https://github.com/crewhaus/factory/blob/main/packages/feedback-distill/src/review-queue.ts).
- **Record/replay + resume:** [`packages/eval-runner`](https://github.com/crewhaus/factory/blob/main/packages/eval-runner).
- **Example manifest:** [`starters/eval/eval-suite.yaml`](../starters/eval/eval-suite.yaml).
- **Module catalog reference:** §16, §29, §38 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
