---
test:
  spec: starters/eval/crewhaus.yaml
  bun_scripts:
    - smoke:section-29
  packages:
    - packages/eval-dataset
    - packages/eval-grader
    - packages/eval-runner
    - packages/eval-report
    - packages/dataset-registry
    - packages/grader-registry
    - packages/regression-runner
---

# Recipe 12 — Eval Harness

Run an agent against a labelled dataset, grade every sample with one
or more graders, and produce an HTML report you can drill into. This
is the foundation that canary gating and prompt optimization sit on,
and it's the first thing to set up if you're putting an agent in front
of users.

<details>
<summary><strong>Architectural context</strong> — why eval is a first-class subsystem, not a dashboard</summary>

The eval stack is Pillar 2 of the crewhaus thesis
([CLAUDE.md](https://github.com/crewhaus/factory/blob/main/CLAUDE.md)): **eval is active, not passive** —
failures should produce *spec patches*, not just HTML reports. The
empirical case for that pillar comes from DSPy's MIPRO result:
prompt optimization at the program/harness layer produces measurable
accuracy gains on multi-stage LM programs — one of the few
primary-source results attributing measurable gains to the
harness/programming layer itself, rather than to model choice or
prompt-engineering folklore.

The landscape also signals that eval should be layered, not monolithic:

- **HELM** is the strongest neutral cross-model benchmark surface.
- **`lm-evaluation-harness`** remains the most reusable open
  benchmark runner.
- **Ragas** specializes in retrieval-centric grading (faithfulness,
  answer-relevancy) — pair with [Recipe 06](06-rag-pipeline.md).
- **DSPy `Evaluate` + MIPRO** is the optimizer story.
- **OpenAI Evals, Foundry evaluators, ADK golden datasets, Haystack
  evaluation, LlamaIndex evaluation, CrewAI testing** all ship
  framework-native eval surfaces.

The `target: eval` shape exposes the layered stack as composable
spec fields: deterministic graders, NLG metrics, and LLM-as-judge can
all run on the same dataset, write to the same report, and feed the
same canary gate ([Recipe 21](21-deployment-and-canary.md)) — which is
what makes the loop close back to spec mutation in
[Recipe 42 — Active Optimization](42-active-optimization.md). If
you've only built the report, you've built the passive half of the
stack; the active half is what the thesis is actually arguing for.

</details>



By the end of this recipe you'll have:

- A small JSONL dataset with a train/dev/test split.
- A graders config that mixes deterministic graders, registry packs, and
  LLM-as-judge — with an explicit combination policy.
- A `crewhaus eval` run that grades a `target: cli` agent against the
  dev split and writes a sortable HTML report.
- A `target: eval` spec that compiles to a standalone bundle running
  the same loop.
- A diff between two eval runs that shows what flipped pass/fail, with a
  paired significance test beside it.
- An understanding of where eval plugs into canary rollouts and
  prompt optimization.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) so you have a
  spec to grade.
- An Anthropic credential in `.env` if you want to run live eval
  rather than just compile the bundle.

## Step 1 — Two ways to run an eval

There are two entry points into the eval stack, and they take different
spec shapes:

- **`crewhaus eval`** grades a **`target: cli`** spec — the agent under
  test — passing the dataset and graders as separate flags. This is the
  interactive, run-from-the-CLI path used through the rest of this recipe.
- **The `target: eval` shape** bundles the agent, dataset reference, and
  graders into one spec that **compiles to a standalone bundle** you run
  directly with `bun` (no `crewhaus eval` involved). It's the shape you'd
  check in and deploy.

### The `target: cli` spec `crewhaus eval` grades

`crewhaus eval` takes the same plain agent spec you'd use for
[Recipe 01](01-cli-coding-agent.md) — just the agent under test:

```yaml
name: hello
target: cli
agent:
  model: claude-opus-4-7
  instructions: |
    Answer math questions with just the number.
```

The dataset and graders live outside the spec and are passed on the
command line (`--dataset`, `--graders`); see Step 1.5.

### The `target: eval` shape that compiles to a bundle

The bundled example [`starters/eval/crewhaus.yaml`](../starters/eval/crewhaus.yaml)
folds the agent, dataset reference, and graders into one spec and
compiles to a self-contained `agent.ts`:

```yaml
name: hello-eval
target: eval
agent:
  model: claude-opus-4-7
  instructions: |
    Answer math questions with just the number.
dataset:
  name: hello-eval
  version: v1
  split: dev
graders:
  - name: exact_match
concurrency: 2
```

Five top-level fields:

| Field         | Purpose                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `agent`       | The agent under test. Same shape as a CLI agent block.                 |
| `dataset`     | Which dataset + version + split to evaluate against.                   |
| `graders`     | Array of `{name, opts?}` — here `name` **is** the type discriminator.  |
| `concurrency` | How many samples to run in parallel. Default 4.                        |
| `seed`        | Optional integer seed for grader / sampling determinism.               |

> **Two grader grammars, and mixing them up is the #1 parse error.**
> Inside a `target: eval` spec (above) an entry is `{name, opts?}` and
> `name` doubles as the type — which is why `- name: exact_match` alone
> works. Inside a **standalone `graders.yaml`** (what `--graders` takes)
> every entry declares an explicit `type:`, `name:` is just the report
> label, and `opts:` is legal **only** on `type: registry` entries. Step 3
> is about the standalone file.

Compile to see the generated bundle — a single-file `agent.ts` that
loads the dataset registry, parses the synthesized graders config, and
calls `runEval` standalone:

```bash
bun run compile starters/eval
ls starters/eval/dist/   # agent.ts
```

**Multi-stage shapes go through the bridge, not through `crewhaus eval`.**
`crewhaus eval` still grades a `target: cli` spec only. A workflow,
graph, crew, or pipeline gets evaluated by compiling it with
`--with-eval-harness`, which drives the shape's *actual* compiled
runtime — see [Recipe 61](61-self-building-evals.md#eval-bridges-put-a-non-cli-shape-in-the-flywheel).

## Step 1.5 — Run the eval end-to-end

Before unpacking datasets and graders, prove the runtime is wired by
running the in-process eval probe — five fixtures that exercise the
dataset registry, grader registry, regression runner, and prompt
optimizer with no model calls or credentials:

```bash
bun run smoke:section-29
# Five probes pass in under 2 seconds.
```

Then run the math eval against the dev split, with the `exact_match`
grader scoring each sample. `crewhaus eval` grades a `target: cli`
spec, so the math agent from Step 1 is saved as
[`starters/eval/agent.cli.yaml`](../starters/eval/agent.cli.yaml).
The `--dataset` flag takes a flat sample file — `.jsonl`, `.csv`,
`.yaml`, or an `http(s)` URL — so point it at the dev split
[`hello-eval/dev.jsonl`](../starters/eval/.crewhaus/datasets/hello-eval/dev.jsonl)
(the versioned `.json` registry format from Step 2 is what the
`target: eval` bundle resolves by name, not what `--dataset` reads):

```bash
cd starters/eval
bunx crewhaus eval agent.cli.yaml \
  --dataset .crewhaus/datasets/hello-eval/dev.jsonl \
  --graders graders.yaml \
  --concurrency 2 --seed 42 \
  -o .crewhaus/evals/run-1
# ✓ d1  exact_match  7   (pass)
# ✓ d2  exact_match  5   (pass)
# …  d3–d6 …
# [eval] runId=eval_… pass_rate=100.0% pass_rate_ci95=[61.0%,100.0%]
#        mean_score=1.000 mean_score_ci95=[1.000,1.000] errors=0 tokens=…/…
#        → report .crewhaus/evals/run-1/index.html
```

Note the **95% confidence intervals** on the summary line (Wilson for
the pass rate, Student t for the mean score). At n=6 the point estimate
alone overstates certainty by a mile, and the interval says so. They are
stored in `results.json` as `passRateCI95` / `meanScoreCI95`, inherited
by `--models` matrix cells, and **absent** (never fabricated) when the
data can't support them — 0 graded samples, or fewer than 2 scored.

**Before any model call**, the run does an offline *preflight lint-lite*:
duplicate sample ids and an all-gold-less dataset scored by gold-needing
graders (`exact_match` / `expected_contains`) **refuse the run**; partial
gold gaps warn on stderr and proceed. `--no-preflight` skips it;
`crewhaus dataset lint` is the full offline check.

Per-sample artifacts land at
`.crewhaus/evals/run-1/<sampleId>/{transcript.jsonl, events.jsonl, grades.json}`.
That's the whole loop end-to-end. The sections below explain each
piece: dataset authoring (Step 2), the grader grammar that drives the
pass/fail decision (Step 3), the runner CLI in full (Step 4), and how
diff mode, custom graders, and canary rollouts compose on top.

## Step 2 — Authoring a dataset

The runner reads from a `dataset-registry` keyed by `(name, version, split)`.
File-backed registries live under `.crewhaus/datasets/<name>/<version>.json`
by default.

A dataset file looks like:

```json
{
  "name": "hello-eval",
  "version": "v1",
  "splits": {
    "train": [
      { "id": "t1", "input": "What is 2+2?", "expected_output": "4" },
      { "id": "t2", "input": "What is 7*8?", "expected_output": "56" }
    ],
    "dev": [
      { "id": "d1", "input": "What is 10-3?", "expected_output": "7" },
      { "id": "d2", "input": "What is 15/3?", "expected_output": "5" }
    ],
    "test": [
      { "id": "x1", "input": "What is 17+25?", "expected_output": "42" }
    ]
  },
  "sampleHashes": {},
  "createdAt": "2026-05-09T00:00:00Z"
}
```

Three splits, one purpose each:

- **`train`** — for prompt-optimizer search, hyperparameter tuning,
  anything that touches the dataset to shape the agent.
- **`dev`** — for development-time grading. The default split for
  `target: eval`.
- **`test`** — for the final go/no-go decision, spent deliberately.

### The test-split lock, on every consumption path

This is the change most likely to move your numbers on upgrade. The
holdout is now locked at **every** CLI path that *consumes* a dataset,
not just in the library:

| Path | Behavior |
| ---- | -------- |
| bare `registry:<name>` | resolves **train + dev only**, with a one-line stderr notice when a test split existed and was excluded |
| explicit `#test` | requires `--allow-test-split`, accepted by exactly two verbs: `crewhaus eval` and `crewhaus deploy canary` |
| `optimize` / `flywheel` | **refuse `#test` outright**, flag or no flag |
| `datasets get` | still prints test rows (inspection ≠ consumption) but says so on stderr |
| `eval coverage` | still inspects bare refs across **all** splits — gap analysis over a partial record would misreport |
| a `target: eval` spec declaring `split: test` | threads the allowance into the emitted bundle (spec-declared explicitness) instead of throwing at runtime |

**Behavior change:** on a record that carries a test split, a bare-ref
run now grades **fewer** samples, so its dataset content hash changes and
the next `eval` starts a **new baseline lineage**. That is by design —
the old number measured a different dataset.

The sanctioned way to spend the holdout is
`crewhaus datasets release <name> --spec <s.yaml> --graders <g.yaml>`,
which runs the `#test` split (regression union skipped so the holdout
stays pure) and appends a `{version, runId, ts, passRate}` release entry
to the record. A second release on the same version is **refused without
`--force`** — a re-run holdout score is no longer a first look.

### Sample fields

`{ id, input, history?, expected_output?, expected_tools?, metadata? }`.
Two are newer than most datasets in the wild:

- **`history`** — `[{role: "user"|"assistant", content: string}]`, at
  least one entry when present. Its messages are seeded into the session
  transcript **verbatim, with no model calls**; `input` stays the single
  graded turn. Seeded turns appear in the per-sample transcript (so a
  `target: transcript` judge sees them), but tool-call accuracy, token
  sums, per-model-call latencies and `turns` measure **only** the final
  turn. CSV authors it as a JSON-encoded `history` column.
  > A dataset that already carried a free-form `history` key used to have
  > it silently stripped. It now validates: a shape-mismatched value
  > fails the load loudly, and a shape-matched one starts seeding turns
  > (which changes that dataset's sample hashes).
- **`metadata.source`** — the provenance taxonomy, canonical and
  enforced: `human_authored | production_log | synthetic |
  synthetic_human_verified | canary`. `registerDataset` warns on stderr
  (never fails) when a declared value falls outside it, and
  `dataset lint` lists the offenders. One hard invariant in the registry:
  a `source: "synthetic"` sample carrying an `expected_output` is
  **refused** at `put`, pointing you at `synthetic_human_verified` — a
  human-verified gold is a different thing from a generated one.

`metadata` is also what `--slice` groups by (Step 4), so a `family` /
`difficulty` / `language` tag on every sample buys you a per-slice pass
rate for free.

### Hygiene before you spend

```bash
crewhaus dataset lint --dataset registry:hello-eval --strict   # offline, no model calls
crewhaus datasets verify hello-eval                            # content hashes vs. what put recorded
crewhaus datasets card hello-eval -o eval/DATASHEET.md         # markdown datasheet
crewhaus datasets status hello-eval --runs 10                  # freshness + saturation
```

`dataset lint` errors on duplicate sample ids, empty-string golds, a
gold-needing grader over a dataset where **no** sample carries a gold,
and any `--canary` phrase found in `crewhaus.yaml` or a
`.crewhaus/fewshot` pool (that's contamination). It warns on
near-duplicate inputs, ids reused with different content across
versions, and off-taxonomy `metadata.source`. `--strict` exits non-zero
on any finding, which makes it a CI gate. `datasets status` also names
**rotation candidates**: sample ids that appeared in ≥2 of the last N
runs and passed every time are no longer measuring anything.

To register a dataset programmatically, see the section-29 smoke at
[`smoke/section-29-smoke/smoke.ts`](https://github.com/crewhaus/factory/tree/main/smoke/section-29-smoke/smoke.ts).

## Step 3 — The `graders.yaml` grammar

Everything in this step describes the **standalone** `graders.yaml` that
`--graders` reads
([`packages/eval-grader/src/graders-config.ts`](https://github.com/crewhaus/factory/blob/main/packages/eval-grader/src/graders-config.ts)).
The whole file:

```yaml
combine: all              # all (default) | any | weighted
passing_threshold: 0.7    # weighted-mode cut on the COMBINED score (default 0.5)
graders:                  # at least one
  - name: math_exact      # the report label
    type: exact_match     # the discriminator
```

**The top level is `.strict()`.** A typo'd `combined:` or
`passing_treshold:` is now a **loud parse error** instead of a silently
ignored policy — the trap this strictness exists to close is a run that
proceeds in default `all` mode while you believe your declared policy
applied.

### Combination policy (`combine:`)

| Mode | `passed` | `score` |
| ---- | -------- | ------- |
| `all` (default) | AND of every grader | **unweighted mean** |
| `any` | OR | **max** |
| `weighted` | `score ≥ passing_threshold ?? 0.5` | `Σ(weight·score) / Σweight` |

An invoker **error** fails the sample in every mode. Declaring `weight:`
or `passing_threshold:` **without** `combine: weighted` now **warns
loudly on stderr at run start** rather than being silently ignored.

> `all`'s score being the *mean* is not the same as the programmatic
> `all([...])` composer, whose score is the **minimum**. If a doc or a
> distilled grader file tells you stacked graders "min-collapse", it is
> describing the composer, not this policy.

### Grader types

Every entry takes an optional positive `weight:` (default 1). A `weight`
of `0` or a negative weight — previously parsed on `llm_judge` and
ignored — is now **rejected at parse time**.

| `type:` | Its own keys | Behavior |
| ------- | ------------ | -------- |
| `exact_match` | `trim` (default true), `case_insensitive` | output equals the sample's `expected_output` |
| `expected_contains` | `case_insensitive` | output **contains the sample's own trimmed gold**. Fails loudly with no gold, and also when the gold is empty after trimming (`''` is a substring of everything) |
| `contains` | `substring` (**required**), `case_insensitive` | output contains a **config literal** — the same needle for every sample |
| `regex` | `pattern` (**required**), `flags` | the regex matches the output |
| `json_path` | `path` (**required**), `expected` | extract via JSONPath, compare |
| `tool_call_sequence` | `expected` (**required**, string[]), `mode: exact\|subseq\|set` | match the run's tool calls |
| `llm_judge` | `rubric` (**required**), `model`, `judges`, `target`, `temperature`, `repeats` | below |
| `registry` | `grader` (**required**), `opts` | resolve a grader pack or `.crewhaus/graders` plugin by name |

`contains` vs `expected_contains` is the distinction worth internalizing:
one takes a literal from the config, the other takes each sample's own
gold. Writing `substring: expected_output` searches the answer for the
*text* "expected_output" and fails everything — that's what
`expected_contains` is for.

There is no `schema` **type** in this file (the `schema()` grader is
code-API only, and takes a Zod object no YAML can express), and the
`all` / `any` / `weighted` *composers* are likewise code-API only —
here they are the `combine:` policy above.

### LLM-as-judge

For "is this answer good?" judgments that don't reduce to a regex. The
rubric is **inline** — there is no `rubric_path`, no `judge_model`, and
no sibling `threshold`; the entry is `.strict()`, so a typo'd
`temperture:` or `repeat:` fails the parse loudly:

```yaml
graders:
  - name: answer_quality
    type: llm_judge
    model: claude-haiku-4-5-20251001   # default: --judge-model, else claude-sonnet-4-5
    temperature: 0                     # judge decoding pin, 0..1 (DEFAULT 0)
    repeats: 3                         # odd panel; MEDIAN score wins (default 1)
    target: output                     # output (default) | transcript
    weight: 2
    rubric:
      passing_score: 4                 # 1..5, scalar rubrics only
      criteria:
        - name: factual_accuracy
          description: The agent's claims are supported by the expected answer.
          anchors:
            "1": no overlap with the expected answer
            "2": mostly unsupported claims
            "3": some claims supported, some not
            "4": nearly every claim supported
            "5": every claim supported by the expected answer
```

Options worth knowing:

| Key | Effect |
| --- | ------ |
| `temperature` | **Behavior change: the judge is pinned to 0 by default now** (it used to take the provider default, ~1.0). Verdicts and `(name, dataset)` baselines may shift on your first run after upgrading. |
| `repeats: k` | odd `k` only. Fans out a k-judge panel, takes the **median** score, records per-repeat scores and modal agreement in the rationale; a strict majority of abstains abstains the verdict. |
| `judges: [m1, m2]` | a multi-model **panel**. Overrides `model:` *and* `--judge-model`. Grade = median score over non-abstaining panelists, `passed` by **strict majority** (an even panel's tie conservatively fails). With `repeats` too, repeats apply **per panelist** (k×m calls). |
| `target: transcript` | the judge reads a bounded, sentinel-wrapped **trajectory digest** (turns, tool calls, tool results, errors) instead of the final answer: most-recent-turns-win within a ~24k-char budget, each event clipped to 2k chars tail-first, dropped history announced by a `[transcript truncated: …]` header. A transcript-less run degrades behind an explicit `(no transcript recorded)` marker. **An output-judged and a transcript-judged run are different instruments** — the effective target is recorded per grader in `judgeSampling`. |

Two panel signals land in the results:

- **Vote entropy.** A normalized entropy > 0.8 on the pass/fail split (a
  2–1 or 3–2 split; 4–1 stays quiet) flags the sample `needs_review`.
  The verdict still **counts** — the pass-rate denominator is unchanged,
  unlike abstention.
- **Per-criterion scores.** Each `llm_judge` grade now carries the
  rubric's raw 1–5 `criterion_scores` as a `detail` field, folded into
  per-criterion means (`criterionMeans`) with one
  `[eval] judge criteria <grader>:` line and a table in the report.
  Abstained verdicts carry none.

**Categorical rubrics** are the second branch — the judge picks exactly
one label through a forced `submit_label` tool call, `passed` is
membership in `passing_labels`, and `score` is the label's declared 0..1
value (no 1–5 projection):

```yaml
  - name: verdict
    type: llm_judge
    rubric:
      kind: categorical
      labels:
        - { name: correct, score: 1, description: factually correct and complete }
        - { name: wrong,   score: 0, description: contains a factual error }
      passing_labels: [correct]
```

The label scores and the passing set are deliberately hidden from the
judge. Duplicate or undeclared labels are rejected, a leftover scalar
`criteria:` block is a loud parse error, and **`repeats` / `judges` are
rejected** with a categorical rubric (there's no label-vote fold yet).
Categorical rubrics also never consume the `judge calibrate --apply` cut
— their gate is label membership, not a number.

### Registry graders (packs and plugins)

`type: registry` resolves a name from the default grader registry —
**eight namespaces** plus any `.crewhaus/graders` plugins, which win on
name collisions:

```yaml
  - name: close_enough
    type: registry
    grader: semantic.similarity
    opts: { threshold: 0.8, disableFallback: true }
```

| Namespace | Names |
| --------- | ----- |
| `nlg.*` | `nlg.rouge1` / `nlg.rouge2` / `nlg.rougeL`, `nlg.bleu1..4`, `nlg.meteor` |
| `semantic.similarity` | cosine over embeddings; degrades to ROUGE-L if the embedder errors |
| `safety.*` | `safety.piiLeak`, `safety.toxicity` / `safety.bias` (+ the explicit offline `.heuristic` variants) |
| `multimodal.*` | `multimodal.imageSimilarity`, `multimodal.imageOcrThenGrade`, `multimodal.audioTranscriptMatch` |
| `calibration.*` | `calibration.abstentionAware` |
| `consistency.*` | `consistency.paraphraseGroup` |
| `continuity.*`, `twelve.*` | the 0.3.0 continuity + twelve-metric packs |

Two of these are newer and behave unusually enough to call out:

- **`calibration.abstentionAware`** classifies each sample
  answered-correct / answered-wrong / **not-attempted** (empty output or
  a *terminal* explicit decline — "I'm not sure, but it's Paris." counts
  as an attempt). Answered samples grade against `expected_output` under
  `opts: {mode: exact|contains, caseInsensitive}`; an answered sample
  with no gold is a loud grader error. It emits an additive
  `aggregates.calibration` = `{answerRate, abstentionRate,
  accuracyWhenAnswered}` — the last one **absent**, never NaN, when
  nothing was answered.
- **`consistency.paraphraseGroup`** is a **vacuous pass per sample**
  (declaring it *is* the opt-in). The real measurement happens at
  aggregation, over samples sharing a `metadata.paraphrase_group`:
  `aggregates.paraphraseConsistency` = `{consistencyByGroup,
  meanConsistency, groupCount}`. **Documented side effect:** because the
  per-sample pass contributes a constant score of 1, `meanScore` (and a
  `combine: weighted` combined score) **shifts upward** the moment you
  declare it. `passRate` under `all`/`any` is unaffected.

**`opts:` is validated per pack at run start.** An unknown or
out-of-range key is a loud error naming that pack's accepted vocabulary
— never silently ignored. Several packs (`consistency.paraphraseGroup`,
`twelve.*`, `continuity.*`, `multimodal.audioTranscriptMatch`) accept
**no** opts and loud-reject an `opts:` block. The per-pack table lives in
[Recipe 34](34-building-custom-graders.md#pack-opts-are-strictly-validated-at-run-start),
along with the plugin contract (plugins get the record **verbatim and
unvalidated** as an optional third grader argument).

Wiring notes: `safety.toxicity` / `safety.bias` resolve a judge-backed
classifier lazily from `CREWHAUS_EVAL_CLASSIFIER` or `opts.classifier`
(the honest keyword mocks live under the explicit
`safety.toxicity.heuristic` / `safety.bias.heuristic` names);
`multimodal.imageOcrThenGrade` resolves OCR from
`CREWHAUS_EVAL_VISION_MODEL` or `opts.model`; and
`multimodal.audioTranscriptMatch` **remains a wiring-explaining
thrower** — no bundled adapter carries audio input, so a plugin (or a
programmatic `SttFn`) is the only route.

### Are your graders any good?

A grader is a measurement instrument. Meta-eval it against human
verdicts before you let it gate anything:

```bash
crewhaus graders test --graders eval/graders.yaml \
  --golden eval/golden-verdicts.jsonl --min-agreement 0.85
crewhaus graders card --graders eval/graders.yaml -o eval/RUBRIC-CARD.md
```

Full walkthrough in [Recipe 34](34-building-custom-graders.md#meta-eval-is-your-grader-any-good).

## Step 4 — Running an eval

`crewhaus eval` grades a `target: cli` spec; the dataset and graders are
passed as flags (the `target: eval` shape that bundles all three is a
separate path — Step 1):

```bash
cd starters/eval
bunx crewhaus eval agent.cli.yaml \
  --dataset .crewhaus/datasets/hello-eval/dev.jsonl \
  --graders graders.yaml \
  --concurrency 2 \
  --seed 42 \
  -o .crewhaus/evals/run-1
```

Per-sample artifacts land at
`.crewhaus/evals/run-1/<sampleId>/{transcript.jsonl, events.jsonl, grades.json}`.
A summary report writes to `.crewhaus/evals/run-1/index.html`.

The HTML report is a self-contained file with:

- A sortable per-sample table (passed/failed, score, latency, turn
  count, model).
- Click any row for a drilldown panel: full transcript on the left,
  trace timeline on the right (the same span layout Studio uses), and
  every grader's pass/fail + rationale at the bottom.
- Aggregates: pass rate + mean score with 95% CIs, p50/p95 turn count +
  latency, total token cost (per-provider pricing table), per-slice and
  per-criterion tables, and a section per non-verdict bucket.

### The five result buckets

A sample's outcome is no longer just pass/fail. Four buckets sit beside
it, and they differ in exactly one way that matters: whether the sample
is in the **pass-rate denominator**.

| Bucket | In the denominator? | What it means |
| ------ | ------------------- | ------------- |
| pass / fail | yes | an ordinary verdict |
| **`needs_human`** (abstained) | **no** — also out of `meanScore` | an `llm_judge` declined for insufficient evidence. `passed: false` / `score: 0` are *conservative placeholders, not measurements*. Excluded from the baseline gate's flip comparison too (`[eval] gate: excluding N abstained sample(s)…`) |
| **`needs_review`** | **yes** | a judge **panel** split its vote (normalized entropy > 0.8). The verdict still counts; the sample is flagged for a human to look at |
| **`canary`** | **no** — also out of `meanScore` | a contamination tripwire from `datasets put --canary`. Disjoint from the two above |
| **`flaky`** (`--repeats` only) | **yes** | the sample's trials disagreed (`0 < trialPassRate < 1`). Its verdict is a coin flip, but **quarantine is not a decision the runner makes** |

They print as their own lines and land in `results.json` with id lists:

```
[eval] needs_human=2: d3, d7 — judge abstained; review with `crewhaus rate`
[eval] needs_review=1: d5 — panel vote split; verdicts still count
[eval] canary=1: canary_0 — contamination tripwires; excluded from pass rate
[eval] flaky=2/40: d2 (2/3), d9 (1/3) — trials disagreed, so these verdicts are coin flips; verdicts still count
```

`needs_human` and `needs_review` samples are also enqueued into the
persistent review queue (`.crewhaus/review/queue.jsonl`) — best-effort,
so a queue write can never fail the run. Drain it with
`crewhaus review next` ([Recipe 74](74-eval-suites-and-cassettes.md#part-4--the-review-queue)).

### The flags, in full

| Flag | Default | What it does |
| ---- | ------- | ------------ |
| `--slice <k1,k2,…>` | `family,difficulty,language,source` | group results by **string** metadata values. Per-slice `{sampleCount, passRate, meanScore}` in `results.json`, one `[eval] slice <key>:` line each, sortable table in the report. Computed by the runner, so matrix cells and `target: eval` bundles inherit it; a metadata-less dataset produces byte-identical output |
| `--repeats K` | 1 | run every sample K times; adds `pass@K` / `pass^K` and flake detection. ~K× the wall clock and spend |
| `--gate` | off | exit non-zero when the baseline regression gate fails |
| `--max-p95-latency-ms N` | off | **gate criterion**: fail when p95 per-sample latency rose > N ms vs the pinned baseline |
| `--max-cost-usd F` | off | **gate criterion**, and an **absolute** ceiling rather than a baseline comparison: fail when the run's estimated **total** cost — agent *plus* judge/grader spend — exceeds $F, so a judge-heavy run cannot slip past by metering only its agent half. A pricing miss on *any* model leaves the total unknown, so it **warns instead of failing** |
| `--sample-timeout-ms N` | spec's `limits.deadline_ms` | per-sample agent-invocation watchdog; a timed-out sample records an errored result with full artifacts instead of stalling a concurrency slot |
| `--budget-usd F` | spec's `budget.usd` | run-level **agent** spend cap. At the cap, in-flight samples finish, queued samples abort with `[eval] budget exhausted after k/N samples`, and `results.json` is marked **partial**. Eval always **stops** at the cap — the block's `on_exceed: degrade` ladder never applies to a measurement run. Judge spend is reported but does not move the cap |
| `--record-tools <dir>` / `--replay-tools <dir>` | — | tool cassettes — [Recipe 74](74-eval-suites-and-cassettes.md#part-2--tool-cassettes-record-once-replay-deterministically) |
| `--replay-miss error\|live` | `error` | what a cassette miss does |
| `--resume <runDir>` | — | re-open an interrupted run under its original id, re-running only the missing samples |
| `--allow-test-split` | off | consume an explicit `#test` registry ref |
| `--no-preflight` | off | skip the pre-spend lint-lite |
| `--models <m1,m2,…>` | — | benchmark matrix. Rejects `--gate` / `--no-promote` / `--max-p95-latency-ms` / `--max-cost-usd`, and now also the cassette flags and `--resume` |

**Both ops criteria are baseline-gate criteria**, so both
`--max-p95-latency-ms` and `--max-cost-usd` are rejected alongside
`--sentinel` (which runs its own drift gate) and `--models` (whose cells
skip the `(spec, dataset)` baseline lineage) — rejected loudly rather
than silently ignored.

**`limits:` and `budget:` are honored now (behavior change).** Both
blocks were silently dead inside `crewhaus eval`. `limits.deadline_ms`
bounds each sample's invocation, and the remaining ceilings
(`turn_timeout_ms`, `model_call_timeout_ms`, `max_tool_iterations`,
`max_concurrent_tools`, `context_limit`, `loop_detection`) thread into
each sample's chat loop exactly as `crewhaus run` threads them. Flag
beats spec.

**Judge spend is metered separately.** Every judge call — single
verdicts, each repeat, each panelist under its own model string —
accumulates into `aggregates.judgeUsage`, and the run prints a `cost:`
line breaking out **agent vs judge vs total**. Judge grading often costs
more than the agent run it grades. An unpriced model renders `n/a`,
never a fabricated `$0.0000`. `--budget-usd` still caps **agent** spend
only — it bounds the quantity a spec's `budget.usd` block declares, so
wiring in a judge can never silently shrink an existing run's sample
budget. The `--max-cost-usd` gate is the opposite: it is checked against
the **total** (agent + judge), because gating the agent half alone let a
judge-heavy run print `total=$4.10` and still pass `--max-cost-usd 2.00`.

**Baselines are instrument-aware.** Run-history entries and baseline
pins now record `gradersHash` (and `judgeModel` when `--judge-model`
pinned one). On a mismatch against the pinned baseline, `crewhaus eval`
prints a loud warning and **starts a new baseline lineage** — the same
way a changed dataset does. Editing a rubric is changing the ruler, not
the thing being measured.

### Coverage — which graders can actually score anything?

```bash
crewhaus eval coverage --sessions all --graders eval/graders.yaml
```

`--graders` used to be accepted and ignored; it is real now. It reports
how many samples each grader can actually score (gold-needing vs
gold-less, sharing `dataset lint`'s own predicate so the two surfaces
can't disagree), which declared graders no recent run ever recorded, and
which judge **criteria** never varied across the last few runs — a dead
criterion pays judge tokens and can never change a verdict. Omitting the
flag leaves every rendered byte unchanged.

## Step 5 — Diff mode

The point of having a dev split is to compare runs. After making a
change to your agent, run a second eval:

```bash
bunx crewhaus eval agent.cli.yaml \
  --dataset .crewhaus/datasets/hello-eval/dev.jsonl \
  --graders graders.yaml \
  -o .crewhaus/evals/run-2
```

Then diff:

```bash
bunx crewhaus eval-report diff \
  .crewhaus/evals/run-1 .crewhaus/evals/run-2 \
  -o .crewhaus/evals/diff-1-vs-2
```

The diff report calls out:

- **Regressions** — samples that passed in run-1, fail in run-2.
- **Recoveries** — samples that failed in run-1, pass in run-2.
- **Score shifts** — same-verdict pairs where `|Δscore|` moved by
  strictly more than `--epsilon` (default **0.1** on the normalized 0..1
  scale). **Flips are never subject to it** — a verdict change is a
  verdict change at any epsilon. A 1–5 rubric and a 0/1 grader deserve
  different tolerances; that's what the knob is for.
- **Per-slice deltas** — for the slice (key, value) pairs both runs
  share, as `sliceDeltas` in `diff.json`, a table in the HTML, and a
  stdout tail table.
- **Instrument warnings** — a `gradersHash` or `judgeModel` disagreement
  between the two runs is reported on stderr, because a score delta may
  then reflect the rubric change and not the agent.

Latency is **not** a diff criterion; it's a gate criterion
(`eval --max-p95-latency-ms`) and a `regression-runner` threshold
(Step 7).

### Paired significance, always on

Every diff now runs a **sign-flip permutation test** over the paired
per-sample pass-rate deltas on shared ids (samples abstained on either
side are excluded, the same exclusion the gate applies). Exact
enumeration at paired n ≤ 20, seeded Monte Carlo above it — and every
draw flows through a deterministic PRNG with a fixed default seed, so
two unseeded diffs of the same runs are byte-identical. `--seed N` pins
it explicitly.

You get a pass-rate delta with a seeded-bootstrap 95% CI, a two-sided
p-value, the paired n, and a plain-language "significant / not
significant at 0.05" verdict — on stdout, in `diff.json` under
`significance`, and in the HTML header.

> **The strict gate is unchanged and never consults significance.** This
> is decision support riding beside the gate, not part of it.

### `--pairwise` — which run answered better?

```bash
bunx crewhaus eval-report diff run-1 run-2 --pairwise --judge-model claude-sonnet-4-5
```

For every shared sample the judge compares the two runs' outputs
**twice**, with the presentation order swapped (fresh injection
sentinels each call, a forced `submit_comparison` tool with a strict
a/b/tie schema, temperature pinned 0). It reports the new side's
win-rate (**ties counted half**) plus an order-consistency figure.

**A verdict that flips with the order is position bias by construction
and consolidates to a tie** — a tie is never counted as a win. This is
opt-in because it costs **2 judge calls per shared sample** and dies
with a clear message without visible judge credentials.

This whole surface is what canary controllers use as their go/no-go
signal — see [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).

### Trends and export

Two offline read verbs for when one diff isn't the question:

```bash
crewhaus eval-report trends --spec hello -o .crewhaus/evals/trends
crewhaus eval-report export --runs last:10 --format csv -o runs.csv
```

`trends` folds `.crewhaus/evals/index.jsonl` into pass-rate / mean-score
/ cost **over time** per (spec, dataset), printing a per-run table and a
movement line per lineage (first → last, delta in **percentage points**);
`-o` additionally writes a self-contained `index.html` (inline CSS +
inline SVG chart, zero external assets) and `trends.json`. It opens no
run directory at all — a three-week drift is one command.

`export` flattens runs into **one row per (run, sample, grader)**: run
config (`runId`, `ts`, `specHash`, `dataset`, `model`, `judgeModel`,
`seed`), the sample's verdict, latency, trial pass rate, flaky flag and
slice membership, then each grader's own `passed` / `score` /
`abstained` / `rationale` (clipped, newline-flattened). **A sample whose
graders never ran still emits a row** — dropping errors is how a pass
rate lies. A moved or unreadable run directory is reported on stderr and
skipped, never silently omitted.

## Step 6 — Custom graders

A grader is a function `(sample, runResult) → { passed, score, rationale }`.
Drop one into the harness's plugin root and reach it by name:

```ts
// <harness>/.crewhaus/graders/my-grader/index.ts
import type { Grader } from "@crewhaus/eval-grader";

export default {
  name: "starts_with_number",
  grader: (sample, result) => {
    const passed = /^\d/.test(result.agentOutput);
    return {
      passed,
      score: passed ? 1 : 0,
      rationale: passed ? "starts with digit" : "does not start with digit",
    };
  } satisfies Grader,
};
```

`<cwd>/.crewhaus/graders` is the **only** discovery root — there is no
home-directory plugin directory. `discoverPluginGraders(registry, root)`
walks `<root>/<plugin>/index.{ts,js,mjs}` and **upserts** each entry, so
a plugin that registers a pack's name deliberately overrides the pack.
Reference it from `graders.yaml` as a registry entry:

```yaml
graders:
  - name: digit_check
    type: registry
    grader: starts_with_number
```

See [Recipe 34 — Building Custom Graders](34-building-custom-graders.md)
for the full walkthrough including LLM-as-judge custom rubrics and the
`opts` contract.

## Step 7 — Wiring eval into canary rollouts

The `regression-runner` package converts two eval runs into a verdict
the `canary-controller` consumes:

```ts
import { gate } from "@crewhaus/regression-runner";
import { loadRun } from "@crewhaus/eval-report";

const prev = await loadRun(".crewhaus/evals/run-1");
const next = await loadRun(".crewhaus/evals/run-2");
const verdict = gate(prev.summary, next.summary, {
  regressionThreshold: 0.02,    // ≤2-point pass-rate drop allowed (default 0.05)
  latencyThreshold: 500,        // ≤500ms p95 drift allowed (default 5000)
  scoreShiftEpsilon: 0.1,       // DEFAULT_SCORE_EPSILON
});
// verdict: { verdict: "pass" | "fail", reason?, report }
```

`loadRun` returns `{ summary, perSample }`, so `gate` takes
`prev.summary` / `next.summary` — the run summaries, not the loaded
wrappers.

`scoreShiftEpsilon` defaults to `DEFAULT_SCORE_EPSILON`, the single
literal `@crewhaus/eval-runner` exports and `eval-report diff --epsilon`
also defaults to. One constant, so the diff a human reads and the gate
that blocks classify identically. (Carried limitation: there is **no**
`crewhaus eval --score-epsilon` — the epsilon is a flag on
`eval-report diff` only, not on the gate/sentinel path.)

In a canary rollout:

- `verdict: "pass"` → promote the new spec version for the env.
- `verdict: "fail"` → re-pin the env back to the prior version and
  log the regression reason to the audit log.

See [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).

## Step 8 — Prompt optimization

DSPy-style search over candidate prompt mutations, driven by your
eval. Lives in [`packages/prompt-optimizer`](https://github.com/crewhaus/factory/blob/main/packages/prompt-optimizer).

```ts
import { optimize } from "@crewhaus/prompt-optimizer";

const result = await optimize(basePrompt, {
  trainSet: trainSplit,
  devSet: devSplit,
  fitness: (prompt) => evaluateOnDev(prompt),  // your eval-runner call
  iterations: 50,
  seed: 42,
  // mutations: defaults cover rephrase-instruction, add-few-shot, swap-example, add-COT-prefix
});
console.log("best prompt:", result.bestPrompt);
console.log("best fitness:", result.bestFitness);
```

The optimizer is **deterministic given the same seed** — same input,
same trajectory. Trajectories persist to
`.crewhaus/prompt-optimizer/<runId>/` so you can resume an
interrupted run.

The split-leak guard from Step 2 is your safety net here: the
optimizer refuses `#test` outright — flag or no flag — and a bare
registry ref resolves train+dev only.

## Step 9 — Sizing the dataset before you pay for it

The honest answer to "is 40 samples enough to detect a 5-point
improvement?" is arithmetic, and it's offline:

```bash
crewhaus eval plan --target-delta 0.05 --confidence 0.95
crewhaus eval plan --target-delta 0.05 --pilot .crewhaus/evals/run-1
```

It prints `n ≈ z²·p(1−p)/e²` with **every term and where it came from**
— which z the confidence bought, which p (a pilot run's measured pass
rate, or the variance-maximizing 0.5 worst case), which e — then the
substituted arithmetic and the **doubled** per-arm budget a two-run
before/after comparison needs. With `--pilot` it also names the smallest
delta that pilot's own n could ever have resolved.

It is honest about its own limits, which is the point of the verb: the
formula sizes an **estimate's width**, not a test's **power** (there is
no z_β term), so at exactly n a true delta of e clears the interval only
about half the time — the output prints the ~80%-power figure beside it.
No model call, no credentials, no spend.

## Common pitfalls

| Symptom                                                              | Fix                                                                                  |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Grader passes locally, fails in CI                                   | Pin `--seed`; verify the model and provider are pinned; for tool-using agents, record a cassette ([Recipe 74](74-eval-suites-and-cassettes.md)). |
| The graders file "silently ignores" my policy                        | It doesn't any more — the top level and the `llm_judge` / `registry` entries are `.strict()`. If the parse errors, that IS the answer: fix the key. |
| Pass rate looks great but the hard cases fail                        | Add `metadata` tags and read the `--slice` table; a macro pass rate holds while a slice collapses. |
| Judge scores moved after upgrading and nothing else changed          | Judge `temperature` is pinned to **0** by default now (it used to take the provider default). Set a rubric-level `temperature` to restore the old behavior, and expect a new baseline lineage. |
| Pass rate dropped and the dataset "didn't change"                    | A bare `registry:` ref now excludes the locked test split, so it grades fewer samples and starts a **new** baseline lineage. The stderr note says so. |
| `meanScore` jumped when I added a grader                             | `consistency.paraphraseGroup` passes vacuously per sample, contributing a constant 1. `passRate` under `all`/`any` is unaffected. |
| Eval seems to be reading the test split                              | It can't without `--allow-test-split` on `eval` / `deploy canary`. `optimize` and `flywheel` refuse it outright. Spend it deliberately with `datasets release`. |
| Per-sample HTML report shows no transcript                           | The runner writes `transcript.jsonl` per sample; check your `-o` path is writable and didn't fall back to a tmpdir. |
| Concurrency = 32 but only 4 samples run at once                      | Provider rate limits. Check [`packages/rate-limiter`](https://github.com/crewhaus/factory/blob/main/packages/rate-limiter) buckets; for Anthropic, raise the per-provider concurrency. |
| The run died halfway and you don't want to re-pay                    | `crewhaus eval --resume <runDir>` reloads every sample that already wrote `grades.json`. |

## What to read next

- **Custom graders, deeper.** [Recipe 34 — Building Custom Graders](34-building-custom-graders.md).
- **CI tiering, tool cassettes, red-team probes, and the review queue.** [Recipe 74 — Eval suites, cassettes, red teams](74-eval-suites-and-cassettes.md).
- **Canary rollouts using the diff.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **Evaluating a non-cli shape.** [Recipe 61 — Self-building evals](61-self-building-evals.md) — `compile --with-eval-harness` drives the shape's real compiled runtime.
- **Observability inside a single eval run.** [Recipe 17 — Observability](17-observability.md) — the per-sample transcript is a full trace event log.
- **Multi-provider eval.** Run the same dataset against `claude-sonnet-4-6`, `openai/gpt-4o`, and `gemini/2.0-flash` by changing one line in the spec; see [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md) for adapter mechanics.

## Pointers to source

- **Example:** [`starters/eval/crewhaus.yaml`](../starters/eval/crewhaus.yaml).
- **Codegen:** [`packages/target-eval-bundle`](https://github.com/crewhaus/factory/blob/main/packages/target-eval-bundle).
- **Modules:** [`packages/eval-dataset`](https://github.com/crewhaus/factory/blob/main/packages/eval-dataset), [`packages/eval-grader`](https://github.com/crewhaus/factory/blob/main/packages/eval-grader), [`packages/eval-judge`](https://github.com/crewhaus/factory/blob/main/packages/eval-judge), [`packages/eval-runner`](https://github.com/crewhaus/factory/blob/main/packages/eval-runner), [`packages/eval-report`](https://github.com/crewhaus/factory/blob/main/packages/eval-report).
- **Production graders:** [`packages/grader-nlg-metrics`](https://github.com/crewhaus/factory/blob/main/packages/grader-nlg-metrics), [`packages/grader-semantic-similarity`](https://github.com/crewhaus/factory/blob/main/packages/grader-semantic-similarity), [`packages/grader-safety-classifiers`](https://github.com/crewhaus/factory/blob/main/packages/grader-safety-classifiers), [`packages/grader-multimodal`](https://github.com/crewhaus/factory/blob/main/packages/grader-multimodal).
- **Optimizer:** [`packages/prompt-optimizer`](https://github.com/crewhaus/factory/blob/main/packages/prompt-optimizer).
- **Regression gate:** [`packages/regression-runner`](https://github.com/crewhaus/factory/blob/main/packages/regression-runner).
- **The `graders.yaml` schema itself:** [`packages/eval-grader/src/graders-config.ts`](https://github.com/crewhaus/factory/blob/main/packages/eval-grader/src/graders-config.ts).
- **The default grader registry + pack opts:** [`packages/eval-runner/src/default-registry.ts`](https://github.com/crewhaus/factory/blob/main/packages/eval-runner/src/default-registry.ts).
- **Sample schema (`history`, `metadata`):** [`packages/eval-dataset/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/eval-dataset/src/index.ts).
- **End-to-end smoke:** [`smoke/section-29-smoke/smoke.ts`](https://github.com/crewhaus/factory/tree/main/smoke/section-29-smoke/smoke.ts).
- **Module catalog reference:** §16, §29, §38 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
