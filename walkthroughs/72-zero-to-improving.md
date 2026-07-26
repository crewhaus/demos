---
test:
  spec: starters/ghostwriter/crewhaus.yaml
  packages:
    - packages/eval-runner
    - packages/eval-dataset
    - packages/eval-grader
    - packages/dataset-registry
    - packages/grader-registry
    - packages/eval-optimizer-orchestrator
---

# Recipe 72 — Zero to self-improving: your usage writes your evals

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `eval-runner`, `eval-dataset`, `eval-grader`,
`dataset-registry`, `grader-registry`, `eval-optimizer-orchestrator`, plus
the CLI's response-feedback core ([`apps/cli/src/feedback.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/feedback.ts)).
**Shipped:** everything here ships in crewhaus 0.4.0 (the pieces landed in
0.1.8–0.2.0; see recipes 56/61/62 for each piece's own deep-dive).
**Starter:** [`starters/ghostwriter/`](../starters/ghostwriter/README.md).

Recipes [61](61-self-building-evals.md), [62](62-response-ratings.md), and
[56](56-self-improvement-flywheel.md) each document one instrument in the
self-improvement orchestra. This recipe is the **first-project narrative**
that plays them in order: you start a brand-new harness with *no dataset,
no graders, no evals, and no idea what those words mean* — and thirty days
later it improves itself nightly, gated and reviewed, from nothing but the
way you used it. You will not hand-write a single line of JSONL.

The worked example is a **ghostwriter**: a harness that drafts replies and
posts in your voice. It's the ideal first project for this loop, because
you already produce perfect training data every day without noticing —
**every time you edit a draft before sending it, the edit is the label.**

You'd reach for this when:

- You're building your **first** harness and the eval chapter of every
  guide feels like homework you don't have data for.
- You have (or will have) **real usage** — your own, or your users' — and
  want it to drive quality instead of vibes.
- You want the payoff of [Recipe 56's flywheel](56-self-improvement-flywheel.md)
  without first becoming an eval engineer.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) — you can run a
  spec and know what a session is.
- That's it. This recipe *teaches* the eval vocabulary on the way and
  deep-links [12](12-eval-harness.md)/[42](42-active-optimization.md)/[61](61-self-building-evals.md)/[62](62-response-ratings.md)
  where you'd go deeper.

## The vocabulary, in five sentences

Learn these five words and every eval doc in this repo unlocks:

1. A **sample** is one test case: an `input` (what the user asked) and,
   usually, an `expected_output` (a known-good answer).
2. A **dataset** is a file of samples — the harness's exam paper.
3. A **grader** is the marking scheme: a function that scores one answer,
   deterministically (`contains`, `regex`, `tool_call_sequence`) or by
   asking a model to judge against a rubric (`llm_judge`).
4. A **baseline** is your current spec's score on the dataset, recorded so
   later changes can be compared against it.
5. A **gate** is the rule that a change lands only if the score strictly
   improves with **zero regressions** (no sample that passed now fails).

The rest of this recipe exists because of one fact: **you never have to
write any of these by hand.** The spec scaffolds the first dataset and
grader; your ratings grow the real ones; the market of your own reactions
does the labeling.

## Day 0 — a spec and its scaffolded exam

Start from the starter. (A bare `crewhaus init ghostwriter --with-evals`
gets you a runnable skeleton plus offline eval stubs too — but you'd
still add the persona and, crucially, the `feedback:` block below by
hand; the starter ships both.)

```bash
cd starters/ghostwriter
cp .env.example .env                    # ANTHROPIC_API_KEY
```

The whole spec is a persona plus one load-bearing block
([`crewhaus.yaml`](../starters/ghostwriter/crewhaus.yaml)):

```yaml
name: ghostwriter
target: cli

agent:
  model: claude-sonnet-4-6
  instructions: |
    You draft replies, emails, and short posts in the operator's voice.
    The voice samples in voice/ are the ground truth for tone — study them
    before every draft: sentence length, warmth, formality, sign-off.
    Output ONLY the draft (no preamble, no "Here's a draft"), ready to
    paste. Match the length the situation calls for — short asks get short
    replies. If the request is missing something you genuinely need (the
    recipient, the goal), ask ONE question instead of guessing. Never
    invent facts, commitments, or dates the operator didn't give you.

tools: [read, glob, grep]

feedback:
  modality: stars
  scale: { min: 1, max: 5 }
  autoDistill: true

permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAllow, pattern: Glob }
    - { type: alwaysAllow, pattern: Grep }
```

`feedback:` declares that this harness collects ratings (`stars`, 1–5) and
— the load-bearing flag — `autoDistill: true`: accumulated ratings are
folded into a versioned dataset automatically at run teardown. It is the
entire "eval infrastructure" you will configure by hand in this project.

Before first use, replace [`voice/`](../starters/ghostwriter/voice/)'s
placeholder samples with 3–5 messages you actually sent.

Now scaffold the day-one exam **from the spec itself** — one command, no
authoring ([Recipe 61 §Scaffold](61-self-building-evals.md#scaffold-eval-assets-from-the-spec)
is the deep-dive):

```bash
bunx crewhaus scaffold-evals crewhaus.yaml --samples 8
```

Open what it wrote, because this is your first dataset and grader and both
are readable:

- `eval/dataset.jsonl` — 8 samples derived from the instructions
  (realistic drafting prompts when credentials let it call the model; a
  deterministic template otherwise). Each line is just
  `{"id": ..., "input": ..., "metadata": ...}` — note there's **no
  `expected_output` yet**. Nobody knows the gold answers on day 0;
  that's precisely what your corrections will supply.
- `eval/graders.yaml` — one starter grader: a spec-goal `llm_judge` rubric
  with credentials, or a non-empty-answer floor grader offline. One,
  deliberately: stacked graders combine as `all(...)` — the *minimum*
  score — so one harsh grader zeroes everything
  ([Recipe 62 §gotcha](62-response-ratings.md#step-2--distill-ratings-into-a-dataset--grader)).

You now have a runnable exam on day zero. It's shallow — scaffolded exams
test that the harness does what the *spec says*, not what *you actually
want* — and that gap is exactly what your usage will fill.

## Days 1–7 — use it, and let your edits do the labeling

Use it for real work, daily:

```bash
bunx crewhaus run crewhaus.yaml
```

```
> Draft a reply to Sam: I can't make Thursday, offer Friday morning.
> Draft a two-paragraph team update: the launch slips a week, nobody's fault, new date May 12.
```

The REPL asks for a one-keystroke `[g]ood/[b]ad` rating on exit, and the
session lands in `.crewhaus/sessions/` — its id (`sess_` + 16 hex) is
the newest filename there (`ls -t .crewhaus/sessions | head -1`). Two
habits, ten seconds each, are the whole data-collection story:

**Habit 1 — rate what you sent as-is:**

```bash
crewhaus rate --session sess_0123456789abcdef --stars 5
crewhaus rate --session sess_0123456789abcdef --turn 2 --stars 2 \
  --comment "way too formal, and it invented a deadline"
```

**Habit 2 — when you edited before sending, paste back what you actually
sent.** This is the strongest training signal that exists — a
`--correction` becomes the **gold answer** for that exchange, even on a
down-voted turn:

```bash
crewhaus feedback --session sess_0123456789abcdef --turn 2 \
  --text "never open with 'I hope this finds you well'" \
  --correction "Hey Sam — Thursday's shot on my end. Friday 9am work?"
```

Mechanics worth knowing (all from [Recipe 62](62-response-ratings.md),
which owns the fine print): ratings append resume-safe `user_feedback`
events to the session's JSONL; `--turn N` counts *user-text* turns
(1-based, omit it for the last turn); every rating normalizes to [0,1] —
thumbs up = 1, stars n = (n−1)/4, so **3★ is *not* positive** under the
default 0.7 threshold.

## Day 7 — watch ratings become a dataset and a grader

`autoDistill` has been quietly doing this after each run (it triggers once
≥5 unprocessed ratings accumulate — and on a channel or managed harness it
also runs on the daemon's janitor clock, which `CREWHAUS_AUTODISTILL=0`
disables). Run it once by hand to *see* the transformation — this is the
moment the eval vocabulary becomes concrete:

```bash
crewhaus distill --all-sessions --register ghostwriter-ratings
crewhaus datasets list
crewhaus datasets get ghostwriter-ratings --split dev
crewhaus datasets card ghostwriter-ratings          # the datasheet, in markdown
```

Two things happen for free that are worth knowing on day 7: free-text
fields are **PII/secret-redacted at construction** (`--no-redact` opts
out, dev/local only), and if you ever get a second rater, disagreements
resolve by majority/mean — with a true split **withheld** and queued for
review rather than silently labeled
([Recipe 62 §Multi-rater agreement](62-response-ratings.md#multi-rater-agreement)).

The tag-all policy ([62 §Step 2](62-response-ratings.md#step-2--distill-ratings-into-a-dataset--grader)):
every rated turn becomes a sample — up-rated turns (and *any* turn with a
correction) become **gold samples**; low-rated turns become **mutation
hints** that feed the optimizer's failure channel without asserting a bad
answer is good. `--register` versions the result in the dataset registry,
referenced everywhere as `registry:ghostwriter-ratings`.

For a ghostwriter you want the judge variant — style is exactly what an
`llm_judge` rubric grades well, and the rubric is *seeded from your own
comments* (what you praised, what you corrected):

```bash
crewhaus distill --all-sessions --judge --register ghostwriter-ratings
```

Read the emitted rubric. You just wrote your first real grader — by
complaining about drafts in `--comment` for a week.

## Day 8 — a baseline, so improvement is a number

```bash
crewhaus eval crewhaus.yaml \
  --dataset registry:ghostwriter-ratings \
  --graders eval/graders.yaml --concurrency 1
```

(`eval` always wants explicit `--dataset` and `--graders` —
[Recipe 12](12-eval-harness.md) is the contract.) The **first run for a
(spec, dataset) pair is pinned as the baseline automatically**; inspect
the run history any time:

```bash
crewhaus eval-report history
crewhaus eval-report baseline show
crewhaus eval-report trends --spec ghostwriter    # once you have a few runs
```

From now on, "did that change help?" has a numeric answer, and any
pass→fail flip on a previously-passing sample is a **regression** the gate
below will refuse.

Two honesty notes about that number, both printed for you:

- The summary line carries **95% confidence intervals**
  (`pass_rate_ci95=[…]`). At a dozen samples the point estimate alone
  overstates certainty badly, and the interval says so. Before you scale
  the dataset up, `crewhaus eval plan --target-delta 0.05 --pilot <runDir>`
  tells you how many samples the change you care about actually needs.
- A bare `--dataset registry:ghostwriter-ratings` resolves **train + dev
  only**; the locked `#test` split is held back for a release gate. If a
  test split exists, a stderr note says it was excluded.

## Day 9+ — close the loop, then automate it

One shot, by hand first ([Recipe 42](42-active-optimization.md) explains
what the optimizer may and may not touch):

```bash
crewhaus optimize crewhaus.yaml --ratings all --write-back
```

`--ratings all` distills inline and uses your golds as the training set
and your low-rated turns as failure signal; `--write-back` patches
`agent.instructions` through the CST round-trip. Read the diff — it will
be eerily specific to your complaints ("never open with…").

Sizing honesty: the optimizer's train/dev split needs ≥2 samples, and a
handful of ratings will overfit happily. Wire everything up on day 9;
*trust* score deltas only after a few dozen ratings.

Then stop running it by hand ([Recipe 56](56-self-improvement-flywheel.md)
owns this command's fine print):

```bash
crewhaus flywheel run --dataset registry:ghostwriter-ratings --concurrency 1
crewhaus flywheel init                    # nightly GitHub Actions + PRs
```

One precedence rule worth learning now: without `--dataset`, the
flywheel prefers a conventional `eval/dataset.jsonl` **over** the
ratings registry — and Day 0 scaffolded exactly that file, so a bare
`flywheel run` would optimize against the 8 shallow stubs instead of
your ratings. It is no longer quiet about it: every run prints
`[flywheel] dataset: <resolved> (source: flag|convention|ratings-registry)`,
and when the conventional file shadows an existing `<spec>-ratings`
dataset it warns with the exact remediation. Pass the registry
explicitly (as above), and once real ratings flow, either retire the
scaffolded file or keep it as a separate smoke set. Everything else
resolves by convention from the
harness directory: the spec, your graders, the `claude` mutator when
credentials are present. The acceptance gate is strict: pass-rate
strictly up, zero per-sample regressions, or the patch never touches
disk. With `flywheel init`, improvements arrive as morning PRs (point
the scaffolded workflow at the registry dataset the same way); you
review a diff with a score delta, or an empty run that found nothing to
improve.

## Week 3+ — the instruments you now know how to hold

Each of these has a home recipe; you now have the data they need:

| Want | Command | Deep-dive |
| ---- | ------- | --------- |
| Catch dataset rot before you spend | `crewhaus dataset lint --dataset registry:ghostwriter-ratings --strict` | [61](61-self-building-evals.md#keep-the-dataset-honest-dataset-lint-and-dataset-audit) |
| Find behaviors no eval covers | `crewhaus eval coverage --sessions all --graders eval/graders.yaml` | [61](61-self-building-evals.md#find-the-gaps-eval-coverage) |
| Harvest hard cases from real struggle | `crewhaus dataset mine --sessions all --review` | [61](61-self-building-evals.md#grow-the-dataset-from-real-usage) |
| Stress-test with paraphrase/injection variants | `crewhaus dataset synthesize --from registry:ghostwriter-ratings --count 3 --budget-usd 1.00` | [61](61-self-building-evals.md#grow-the-dataset-from-real-usage) |
| Draft graders from failure rationale | `crewhaus graders suggest --runs last:10` | [61](61-self-building-evals.md#draft-graders-from-failure-rationale) |
| Check the grader agrees with YOU | `crewhaus graders test --graders eval/graders.yaml --golden eval/golden.jsonl` | [34](34-building-custom-graders.md#meta-eval-is-your-grader-any-good) |
| Calibrate the judge to your taste | `crewhaus judge calibrate --graders eval/graders.yaml --sessions all --apply` | [61](61-self-building-evals.md#draft-graders-from-failure-rationale) |
| Decide what the judges couldn't | `crewhaus review next` | [74](74-eval-suites-and-cassettes.md#part-4--the-review-queue) |
| Watch quality over weeks, not runs | `crewhaus eval-report trends -o .crewhaus/evals/trends` | [12](12-eval-harness.md#trends-and-export) |
| Lift your best drafts into the prompt | `crewhaus fewshot harvest` | [63](63-harness-self-knowledge.md) |
| Spec advice beyond the prompt | `crewhaus advise` → `optimize --from-advice` | [57](57-advisor-loop.md) |

## The 30-day cadence

| When | You do | The system does |
| ---- | ------ | --------------- |
| Daily | use it; rate on exit; paste corrections | `autoDistill` folds ratings into the registry |
| Weekly | skim `eval-report history`; read one distilled rubric; drain `review next` | baseline/regression bookkeeping; the queue collects what judges couldn't decide |
| Nightly (from day ~10) | review the flywheel PR over coffee | compile → eval → optimize → gate → PR |
| Monthly | `dataset lint --strict` + `eval coverage` + `dataset mine --review` + `judge calibrate` + `datasets status` | dataset stays representative and un-saturated; judge stays honest |

Total hand-written eval artifacts after 30 days: **zero.**

## Gotchas recap

| Gotcha | Rule |
| ------ | ---- |
| 3★ is not positive | normalization is (n−1)/4 vs `--min-score 0.7`; pass `--min-score 0.5` to flip it |
| Corrections outrank votes | a `--correction` turn becomes gold even if down-voted — and the correction is the expected output |
| One grader per distill | stacked graders min-collapse; don't append extras to the distilled file ([62](62-response-ratings.md)) |
| autoDistill needs volume | it fires at ≥5 unprocessed ratings (tunable via `CREWHAUS_AUTODISTILL_THRESHOLD`; `CREWHAUS_AUTODISTILL=0` disables the daemon tick on channel/managed harnesses) |
| Tiny datasets overfit | ≥2 samples to even split; trust deltas after dozens of ratings — and read the `pass_rate_ci95` the run prints |
| `eval` has no default paths | always pass `--dataset` and `--graders`. The flywheel's convention prefers `eval/dataset.jsonl` over the ratings registry — but it now **prints the resolved dataset and its source on every run** and warns when the convention shadows your ratings dataset, with the exact remediation. (`eval suite <suite.yaml>` supplies both per entry instead.) |
| A bare registry ref is train+dev | the locked `#test` split is excluded, and both `optimize` and `flywheel` refuse it outright |
| The flywheel refuses dirty specs | commit your own edits first, or `--allow-dirty` knowingly |

## When NOT to use this path

- **You already have labelled data.** Start at [Recipe 12](12-eval-harness.md)
  and import it — bootstrapping from usage is for when you don't.
- **Nobody will actually rate.** Five ratings produce noise. If real usage
  won't generate feedback, scaffold + [`dataset synthesize`](61-self-building-evals.md)
  is the better path.
- **The failure is architectural.** No amount of instruction-tuning adds a
  missing tool — that's [Recipe 57](57-advisor-loop.md)'s advisor, and a
  spec change you make by hand.

## Where to go next

- **The same bootstrap where the grader is the *market*, not you** —
  [Recipe 73 — The trading advisor](73-trading-advisor.md): objective,
  delayed ground truth, and a confidence gate computed in code.
- **Each instrument's own manual:** [56](56-self-improvement-flywheel.md) ·
  [61](61-self-building-evals.md) · [62](62-response-ratings.md) ·
  [42](42-active-optimization.md) · [12](12-eval-harness.md).

## Pointers to source

- **Feedback capture + distill:** [`apps/cli/src/feedback.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/feedback.ts).
- **Scaffolded assets:** [`apps/cli/src/scaffold-evals.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/scaffold-evals.ts).
- **Dataset registry:** [`packages/dataset-registry`](https://github.com/crewhaus/factory/blob/main/packages/dataset-registry).
- **Flywheel orchestrator:** [`packages/eval-optimizer-orchestrator`](https://github.com/crewhaus/factory/blob/main/packages/eval-optimizer-orchestrator).
- **Module catalog reference:** §16, §29, §38, §46 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
