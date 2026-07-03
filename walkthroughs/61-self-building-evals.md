# Recipe 61 — Self-building evals for any shape

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `scaffold-evals`, `eval-coverage`, `dataset-miner`, `dataset-synthesizer`, `grader-suggest`, `eval-bridge-emitter`.
**Shipped:** crewhaus 0.2.0 (`crewhaus scaffold-evals`, `eval coverage`, `dataset mine`/`synthesize`, `graders suggest`, `compile --with-eval-harness`).

The eval flywheel ([Recipe 56](56-self-improvement-flywheel.md)) is only
as good as the dataset and graders behind it — and hand-authoring JSONL
samples and a `graders.yaml` is the cliff most people fall off before
they ever get to optimize. 0.2.0 closes that gap from both ends: eval
assets that **build themselves from the spec and from real usage**, and
**eval bridges** that unlock eval/optimize for the 13 non-cli shapes
that previously couldn't consume their own feedback.

You'd reach for this when:

- You want a **day-one eval harness** without hand-writing JSONL.
- You want to know **which agent behaviors have no eval** covering them.
- You're building a **non-cli shape** (workflow, graph, channel, crew,
  …) and want it in the flywheel too.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) for the dataset +
  graders format everything here generates.
- [Recipe 34 — Building Custom Graders](34-building-custom-graders.md)
  for the grader kinds `graders suggest` drafts.

## Scaffold eval assets from the spec

`crewhaus scaffold-evals` generates day-one eval assets **from the spec
itself** — sample stubs derived from `agent.instructions` (one model
call with credentials, a deterministic template without) plus one
starter grader:

```bash
crewhaus scaffold-evals crewhaus.yaml -o eval --samples 12
```

The starter grader is a spec-goal `llm_judge` rubric when a model is
reachable, or a non-empty-answer floor grader offline. Either way you
land with `eval/dataset.jsonl` + `eval/graders.yaml` you can run
immediately — no JSONL/YAML hand-authoring cliff.

Prefer it at project creation? `crewhaus init --with-evals` scaffolds
the same assets alongside a new spec (offline template mode — no
credentials needed):

```bash
crewhaus init support-agent --with-evals
```

## Find the gaps: `eval coverage`

`eval coverage` detects agent behaviors present in production sessions
that **no eval sample exercises** — tool/MCP calls, bigrams, compaction
paths — ranked by production frequency:

```bash
crewhaus eval coverage --sessions all
crewhaus eval coverage --sessions all --format json -o eval/coverage
```

The JSON output is a backlog for `dataset mine` (below): the behaviors
your users hit most that your eval doesn't cover yet. Close the highest-
frequency gaps first.

## Grow the dataset from real usage

Two `dataset` (singular) subcommands grow the set without hand-writing
samples.

**`dataset mine`** pulls hard cases from session struggle signals —
tool errors, loops, retries, egress blocks — into a quarantine, then
promotes the ones you accept into a mined registry dataset:

```bash
crewhaus dataset mine --sessions all --review
```

`--review` promotes accepted candidates. In a non-TTY (CI), `--review`
alone prints the list; add `--yes` to promote non-interactively — the
tool never silently auto-accepts.

**`dataset synthesize`** grows a dataset with PII- and secret-redacted
stress variants — paraphrase, truncate, ambiguate, inject — into a
**separate synthetic split** that never contaminates your human golds:

```bash
crewhaus dataset synthesize --from registry:support-agent-ratings \
  --count 3 --budget-usd 1.00
```

`--budget-usd` caps the paraphrase spend. The injection-payload
variants are stress tests — they exercise the harness's defenses, and
by construction they land in the synthetic split, never the human-gold
one.

Keep golds honest as the agent improves with **`dataset
refresh-goldens`** — reconcile corrections and up-rated divergent
outputs with the stored golds, proposed as a review diff, written only
with `--apply` (and always as a new registry version, never in place):

```bash
crewhaus dataset refresh-goldens --dataset registry:support-agent-ratings \
  --min-score 0.8            # review the proposed gold updates
crewhaus dataset refresh-goldens --dataset registry:support-agent-ratings \
  --min-score 0.8 --apply    # write a new version
```

## Draft graders from failure rationale

`crewhaus graders suggest` clusters the failure rationale accumulated in
recent eval runs (and rating comments) into themes and drafts a grader
per theme — into a **review file**, never auto-applied:

```bash
crewhaus graders suggest --runs last:10 -o eval/graders.suggested.yaml
```

With `--model` (and credentials) it also drafts an `llm_judge` rubric
from real good/bad exemplars. You review the file and merge the graders
worth keeping into your `graders.yaml`.

Calibrate an LLM judge against your accumulated human ratings so its
score threshold matches human judgment:

```bash
crewhaus judge calibrate --graders eval/graders.yaml --sessions all --apply
```

`--apply` persists the calibrated `--min-score` default to
`.crewhaus/judge-calibration.json`.

## Eval bridges: put a non-cli shape in the flywheel

Here's the big unlock. `crewhaus eval` runs `target: cli`. That meant
the other 13 shapes — workflow, graph, channel, crew, research, batch,
… — couldn't consume their own distilled feedback. The flywheel was a
CLI-only story.

`compile --with-eval-harness` fixes it: alongside the normal bundle it
emits an **eval bridge** — a `target: eval` bundle projected from *this*
non-cli shape's own agent — into `<out-dir>/eval/`. The shape can now be
evaluated, optimized, and flywheeled through that bridge:

```bash
# Compile a workflow AND emit its eval bridge:
crewhaus compile crewhaus.yaml -o dist --with-eval-harness
ls dist/eval/          # the projected target: eval bundle
```

Point `--eval-dataset <name>` at the dataset the bridge consumes
(defaults to `<specName>-eval`):

```bash
crewhaus compile crewhaus.yaml -o dist \
  --with-eval-harness --eval-dataset support-workflow-eval
```

The bridge is **rejected for `cli`** (use `crewhaus eval` directly) and
for multi-stage shapes that can't be projected to a single agent — the
flag tells you which. For every other shape it's how you bring the
whole self-improvement loop from Recipe 56 to a harness that isn't a
CLI.

## The self-building pipeline, in order

```
scaffold-evals / init --with-evals   → day-one dataset + grader
eval coverage                        → which behaviors have no eval
dataset mine --review                → hard cases from real struggle
dataset synthesize                   → stress variants (separate split)
graders suggest / judge calibrate    → graders drafted from failures
dataset refresh-goldens --apply      → keep golds honest over time
compile --with-eval-harness          → bring non-cli shapes into the loop
   └──►  feed it all into the flywheel (Recipe 56)
```

Every step here produces or refines the dataset/graders the flywheel
consumes. Together they mean a harness can be eval-ready on day one and
stay eval-relevant as it changes — without a human hand-authoring a
single JSONL line.

## When to skip a step

- **`dataset mine` / `synthesize` on a fresh harness.** No sessions to
  mine, nothing to grow from — scaffold first, accumulate usage, then
  mine.
- **`--with-eval-harness` on a cli spec.** It's rejected by design; use
  `crewhaus eval` directly.
- **Auto-applying suggested graders.** `graders suggest` writes a
  *review* file on purpose. A grader is a measurement contract — read it
  before you trust it.

## What to read next

- **The flywheel this feeds.** [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md).
- **The dataset + grader format.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Custom grader kinds.** [Recipe 34 — Building Custom Graders](34-building-custom-graders.md).

## Pointers to source

- **Eval runner:** [`packages/eval-runner`](https://github.com/crewhaus/factory/blob/main/packages/eval-runner).
- **Dataset registry:** [`packages/dataset-registry`](https://github.com/crewhaus/factory/blob/main/packages/dataset-registry).
- **Distill / synthesis:** [`packages/eval-optimizer-orchestrator`](https://github.com/crewhaus/factory/blob/main/packages/eval-optimizer-orchestrator).
- **Module catalog reference:** §16, §29, §38 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
