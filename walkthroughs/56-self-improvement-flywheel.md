# Recipe 56 — The self-improvement flywheel

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `eval-runner`, `dataset-registry`, `grader-registry`, `prompt-optimizer`, `prompt-optimizer-claude`, `spec-patch`, `eval-optimizer-orchestrator`, `feedback-distill`.
**Shipped:** crewhaus 0.2.0 (`crewhaus flywheel`, `distill --register`, `feedback.autoDistill`, `eval --gate`).

Recipe 42 showed the manual optimize loop — you hand it a dataset and
graders, it hands you a spec patch. This recipe wires the loop so it
runs **on its own**: real usage becomes rated turns, rated turns become
a versioned dataset, and one command (`crewhaus flywheel run`) turns
that dataset into a regression-gated spec patch that lands as a PR while
you sleep. Nothing is auto-applied without an eval gate, and nothing is
auto-merged.

You'd reach for this when:

- You already ship an agent and want it to **improve from real
  feedback**, not from prompts you hand-tune.
- You want every improvement to arrive as a **reviewable diff** — never
  a silent overwrite.
- You want the loop **scheduled** (nightly) rather than remembered.

If you're still building the agent and don't have real traffic yet,
start with [Recipe 12 — Eval Harness](12-eval-harness.md) to get a
dataset, then come back.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) — the dataset +
  graders that every step here uses as its fitness function.
- [Recipe 42 — Active Optimization](42-active-optimization.md) — the
  single-shot `optimize` loop the flywheel packages. Read it first;
  this recipe assumes you understand the write-back CST round-trip and
  the `OPTIMIZABLE_PATHS` floor.

## The loop, end to end

```
run the agent  ──►  rate turns  ──►  distill --register  ──►  flywheel run  ──►  PR
   (real usage)     (rate/feedback)   (versioned dataset)    (compile→eval→          │
        ▲                                                     optimize→gate→          │
        │                                                     write-back)             │
        └──────────────────────  merge the PR  ◄──────────────────────────────────────┘
```

Each arrow is one CLI command. The rest of this recipe walks them in
order.

## Step 1 — declare that the harness collects feedback

The `feedback:` block (0.2.0) tells the compiled harness to capture
human ratings and, with `autoDistill`, to fold them into a versioned
dataset at run teardown. It's cross-cutting — carried on the `cli` and
`channel` shapes:

```yaml
name: support-agent
target: cli
version: 1
agent:
  model: claude-sonnet-4-5
  instructions: |
    Answer the user's support question. Cite the doc you used.
tools: []
feedback:
  modality: stars
  scale: { min: 1, max: 5 }
  autoDistill: true
```

`autoDistill: true` is the load-bearing flag: instead of you running
`distill` by hand, accumulated ratings become a versioned
`support-agent-ratings` registry dataset at the end of every `crewhaus
run`. The optimizer and eval consume it as `--dataset
registry:support-agent-ratings`.

> The `feedback:` block is deliberately **not** in `OPTIMIZABLE_PATHS`
> — the optimizer can never rewrite how you collect feedback.

## Step 2 — capture ratings from real turns

Whoever is reviewing the agent's output rates a turn. Thumbs, stars, or
a 0–1 score — whichever `modality` the spec declares:

```bash
# Rate the last assistant turn of a session 👍 / 4 stars / 0.9
crewhaus rate --session sess_0a1b2c3d4e5f6789 --thumbs up
crewhaus rate --session sess_0a1b2c3d4e5f6789 --turn 6 --stars 4
crewhaus rate --session sess_0a1b2c3d4e5f6789 --score 0.9 --comment "cited the right doc"
```

When the answer was wrong, attach the *better* answer with `feedback
--correction`. A correction becomes the gold output for that sample —
the strongest training signal there is:

```bash
crewhaus feedback --session sess_0a1b2c3d4e5f6789 --turn 6 \
  --text "missed the refund-window clause" \
  --correction "Refunds are available within 30 days of purchase; see billing/refunds.md."
```

Ratings are recorded as resume-safe `user_feedback` events in the
session JSONL under `.crewhaus/sessions/`, so a mid-session crash never
loses them.

In a Slack channel bot, set `feedback: { channelReactions: true }` and
👍/👎 reactions on the bot's replies become the same `user_feedback`
events — no CLI step needed. See
[Recipe 03 — Slack Bot](03-slack-bot.md) for the channel shape.

## Step 3 — distill ratings into a versioned dataset

`crewhaus distill` pairs each rating with its exchange and emits the two
artifacts the eval stack already consumes: a `Sample[]` dataset
(positively-rated turns become gold samples; corrections win when
present) and a `graders.yaml` with one synthesized grader.

With `autoDistill: true` (Step 1) this happens automatically at run
teardown. To do it explicitly — or to seed the registry from historical
sessions — run it yourself and promote the result into the dataset
registry with `--register`:

```bash
# Distill every session's ratings and register a new version of
# the "support-agent-ratings" dataset (deterministic 70/15/15 split).
crewhaus distill --all-sessions --register support-agent-ratings
```

`--register` gives datasets the same versioned registry the CLI already
gives specs. Inspect what landed:

```bash
crewhaus datasets list                         # every dataset + its versions
crewhaus datasets get support-agent-ratings --split dev
```

You now reference it anywhere a dataset is expected with the
`registry:<name>[@version][#split]` shorthand:
`--dataset registry:support-agent-ratings`.

For a graded LLM-judge instead of deterministic graders, add `--judge`:
the rubric is seeded from the praised-vs-criticized comment themes and
runs one judge call per sample under `crewhaus eval`.

```bash
crewhaus distill --all-sessions --judge --register support-agent-ratings
```

## Step 4 — run the flywheel

`crewhaus flywheel run` is the whole nightly loop as one command:

```
compile gate → baseline eval → optimize → post-patch compile
             → after eval → acceptance gate → write-back (only on accept)
```

```bash
crewhaus flywheel run \
  --dataset registry:support-agent-ratings \
  --budget-usd 2.00 \
  --iterations 8 \
  --seed 42 \
  --concurrency 1
```

The acceptance gate is strict: the patch is written to the spec **only
when pass-rate strictly improved with zero per-sample regressions** —
the same gate `eval --gate` uses. A rejected patch never touches disk.
When it accepts, the standard auto-register + changelog +
regression-pin flow runs, so every accepted win becomes a permanent
regression test.

Sensible defaults make the flags optional. Run from inside a harness
directory and the loop resolves:

- `<spec>` → `./crewhaus.yaml`
- `--dataset` → `eval/dataset.jsonl`, then
  `registry:<spec>-ratings` when the spec has a `feedback:` block
- `--graders` → `eval/graders.yaml`
- mutator → `claude` when an `ANTHROPIC_AUTH_TOKEN` /
  `ANTHROPIC_API_KEY` is present, `rule-based` otherwise

Two safety rails worth knowing:

- The flywheel **refuses to run over uncommitted spec changes** — a
  rejected write-back can't be told apart from your own edits. Pass
  `--allow-dirty` only when you know what you're doing.
- `--dry-run` runs the whole loop (evals + optimize + gate) but never
  writes the spec, registers, or pins — a rehearsal.

```bash
# Rehearse without touching anything:
crewhaus flywheel run --dataset registry:support-agent-ratings --dry-run
```

At `--concurrency 1` the loop makes one eval pass per iteration without
tripping a low provider rate-limit tier — the recommended setting on a
30k-TPM plan.

## Step 5 — schedule it

`crewhaus flywheel init` scaffolds a GitHub Actions workflow that runs
the loop on a nightly cron plus manual dispatch:

```bash
crewhaus flywheel init          # writes .github/workflows/crewhaus-flywheel.yml
crewhaus flywheel init --force  # overwrite an existing scaffold
```

The scaffolded workflow keeps the demo's invariants: accepted
improvements arrive as **PRs for human review** — never auto-merged —
and the optimizer never touches `permissions` or `model` fields
(`OPTIMIZABLE_PATHS` is the floor). Every morning you review a diff with
a score delta in the PR body, or an empty run that found nothing to
improve.

## What each step writes

| Command                         | Writes                                                                 |
| ------------------------------- | ---------------------------------------------------------------------- |
| `crewhaus rate` / `feedback`    | `user_feedback` events in `.crewhaus/sessions/<id>.jsonl`              |
| `crewhaus distill --register`   | a new dataset version in `.crewhaus/datasets/<name>/`                  |
| `crewhaus flywheel run`         | `.crewhaus/optimize/<runId>/` (patch, report, trajectory) + `.crewhaus/evals/` (run history) |
| an **accepted** patch           | the spec YAML (CST write-back) + a `.crewhaus/specs` version + a `<name>-regressions` dataset pin |
| `crewhaus flywheel init`        | `.github/workflows/crewhaus-flywheel.yml`                             |

## Where the loop can't hurt you

- **The gate is not optional.** No patch reaches the spec unless it
  strictly out-evals the current spec on the dev split. A patch that
  merely *looks* better but flips one sample fail→pass and another
  pass→fail is rejected.
- **Permissions and model are off-limits.** `OPTIMIZABLE_PATHS`
  excludes `permissions.*`, `model_router` rules, and MCP configs — the
  optimizer physically can't rewrite your safety floor. See
  [Recipe 42 §Optimizable paths](42-active-optimization.md).
- **Nothing auto-merges.** The scheduled path opens a PR. A human
  merges. The dirty-tree refusal means the loop never silently mixes its
  own write-back with your in-flight edits.

## When to NOT use the flywheel

- **Before you have real ratings.** Five ratings produce noise, not a
  fitness signal. Seed the dataset from a labelled set first
  (Recipe 12), then let ratings accumulate.
- **For architectural fixes.** The optimizer tunes instructions and a
  small set of knobs. If your eval fails because the agent lacks a tool
  or a whole step, no prompt tuning helps — that's a spec change you
  make by hand. See [Recipe 57 — The advisor loop](57-advisor-loop.md)
  for the observer that suggests *those* changes.

## What to read next

- **Suggestions beyond the prompt.** [Recipe 57 — The advisor loop](57-advisor-loop.md).
- **Safe production rollout of an accepted patch.** [Recipe 58 — Safe production ops](58-safe-production-ops.md).
- **The single-shot loop this packages.** [Recipe 42 — Active Optimization](42-active-optimization.md).
- **The dataset + graders behind the gate.** [Recipe 12 — Eval Harness](12-eval-harness.md).

## Pointers to source

- **Flywheel orchestrator:** [`packages/eval-optimizer-orchestrator`](https://github.com/crewhaus/factory/blob/main/packages/eval-optimizer-orchestrator).
- **Dataset registry:** [`packages/dataset-registry`](https://github.com/crewhaus/factory/blob/main/packages/dataset-registry).
- **Spec patch / write-back:** [`packages/spec-patch`](https://github.com/crewhaus/factory/blob/main/packages/spec-patch).
- **Regression gate:** [`packages/regression-runner`](https://github.com/crewhaus/factory/blob/main/packages/regression-runner).
- **Module catalog reference:** §16, §29, §46 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
