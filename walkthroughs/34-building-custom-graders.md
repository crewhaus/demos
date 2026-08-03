# Recipe 34 — Building Custom Graders

Author your own grader for the eval harness — pure-function or
LLM-as-judge — register it via the grader-registry, and either ship
it inline with your spec or drop it in the harness's discoverable
plugin root, `<cwd>/.crewhaus/graders/`.

You'd build a custom grader when:

- The bundled graders (`exact_match`, `expected_contains`, `contains`,
  `regex`, etc.) don't capture what you care about.
- You're scoring something **domain-specific** (correct SQL syntax,
  valid OpenAPI spec, well-formed markdown).
- You need **LLM-as-judge** for fuzzy quality (helpfulness, tone,
  faithfulness to source).
- A registry pack *almost* fits but needs wiring the bundle doesn't
  carry — a plugin is the documented escape hatch every "needs wiring"
  error message points at.

For simple shape checks (string match, JSON schema), the bundled
graders are enough.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) for the eval-runner
  pipeline and the two grader grammars (`graders.yaml` vs. the
  `target: eval` spec's `graders:` list).

## Try it

[`starters/eval`](../starters/eval/README.md) is now the runnable starting
point for custom graders. Compile and run:

```bash
bun run compile starters/eval
bun run run starters/eval
```

Then drop a custom grader at
`starters/eval/.crewhaus/graders/my-grader/index.ts` and reference it
from [`starters/eval/graders.yaml`](../starters/eval/graders.yaml) as a
`type: registry` entry — the same spec re-runs against your new grader.
The NLG, semantic-similarity, safety, and multimodal grader families each
ship their own smoke under
[`smoke/section-38-grader-{nlg-metrics,semantic-similarity,safety-classifiers,multimodal}-smoke/`](../smoke/).

## The grader contract

```typescript
type Grader = (
  sample: Sample,
  runResult: RunResult
) => Promise<GradeResult>;

type GradeResult = {
  readonly passed: boolean;   // the gate
  readonly score: number;     // [0, 1]
  readonly rationale: string; // human-readable
};
```

`passed` is the binary outcome — does this sample pass the test?
`score` is the continuous version (`0` = total failure, `1` = perfect).
`rationale` is a short explanation that lands in the HTML report.

**Plugin graders may take a third parameter.** A grader discovered from
`.crewhaus/graders` receives the `graders.yaml` entry's `opts:` record
**verbatim and unvalidated** — the plugin owns its own vocabulary, and
the registry never drops the record:

```typescript
// PluginGraderWithOpts — packages/eval-runner/src/default-registry.ts
type PluginGraderWithOpts = (
  sample: Sample,
  runResult: RunResult,
  opts?: Readonly<Record<string, unknown>>
) => Promise<GradeResult>;
```

Plugins that ignore the parameter are unaffected. The contrast matters:
**pack** names validate their `opts` strictly at run start (see
[Pack opts are strictly validated](#pack-opts-are-strictly-validated-at-run-start)),
**plugin** names get the record as written.

## Example 1 — Pure-function grader

A grader that asserts the answer starts with a digit:

```typescript
import type { Grader } from "@crewhaus/eval-grader";

export const startsWithDigit: Grader = async (_sample, runResult) => {
  const out = runResult.agentOutput.trim();
  const passed = /^\d/.test(out);
  return {
    passed,
    score: passed ? 1.0 : 0.0,
    rationale: passed
      ? "Output starts with a digit."
      : `Output starts with '${out.slice(0, 1)}' instead of a digit.`
  };
};
```

Register:

```typescript
import { GraderRegistry } from "@crewhaus/grader-registry";

const registry = new GraderRegistry();
registry.register("starts_with_digit", startsWithDigit);
```

Use it from a standalone `graders.yaml` — a registry-resolved grader is
a `type: registry` entry naming the registered name:

```yaml
graders:
  - name: digit_check          # the report label
    type: registry
    grader: starts_with_digit  # the REGISTERED name
```

That's the entire authoring loop. Pure-function graders are
deterministic, fast, free — pick them whenever possible.

## Example 2 — LLM-as-judge

For fuzzy quality questions (faithfulness, tone), you need a model
in the loop. The eval-judge package gives you a structured rubric:
criteria, per-criterion 1–5 anchors, and a `passing_score` gate.
`createJudgeGrader(rubric, opts)` wraps a judge call as a `Grader`:

```typescript
import { createJudgeGrader, loadRubric } from "@crewhaus/eval-judge";

const rubric = loadRubric(`
criteria:
  - name: factual_accuracy
    description: The agent's claims are supported by the expected answer.
    anchors:
      "1": no overlap with the expected answer
      "2": mostly unsupported claims
      "3": some claims supported, some not
      "4": nearly every claim supported
      "5": every claim supported by the expected answer
passing_score: 4
`);

export const factuallyAccurate = createJudgeGrader(rubric, {
  model: "claude-haiku-4-5-20251001",
  // optional: temperature (default 0), repeats (odd — median panel),
  // judges: ["claude-sonnet-5", "openai/gpt-4o"] (multi-model panel),
  // target: "transcript" (judge the trajectory, not the final answer)
});
```

The grader:

- Calls `judge({ rubric, sample, agentOutput })` under the hood with
  the sample's expected output + the run's actual output.
- Resolves `model` (or `DEFAULT_JUDGE_MODEL`) through the model-router
  and extracts a structured `submit_score` tool call.
- Maps the judge's 1–5 `score` to `[0, 1]` via `(n - 1) / 4` and
  gates `passed` on the rubric's `passing_score`.
- Returns a `GradeResult`.
- **Pins `temperature: 0` by default.** Judge decoding is no longer the
  provider default — override per grader with `temperature`.
- **May abstain.** `submit_score` carries optional `abstain` and
  `confidence` fields; an abstaining judge yields
  `passed: false` / `score: 0` as *conservative placeholders, not
  measurements*, and the runner routes the sample to the
  needs-human bucket instead of counting it. See
  [Recipe 12 §The five buckets](12-eval-harness.md#the-five-result-buckets).

### The categorical rubric

`loadCategoricalRubric` (and `kind: categorical` in YAML) is the second
rubric branch: the judge picks **exactly one label** through a forced
`submit_label` tool call, `passed` is label ∈ `passing_labels`, and
`score` is the label's own 0..1 value — no 1–5 projection:

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

The label scores and the passing set are deliberately **hidden from the
judge**. `repeats` and `judges` are **rejected at parse** with a
categorical rubric (there is no label-vote fold yet), and a categorical
rubric never consumes the `judge calibrate --apply` cut — its gate is
label membership, not a numeric threshold.

### Defending against injection

The sample's expected output is **untrusted-ish** — it's data, not
instructions, but a maliciously-crafted "expected" string could try
to manipulate the judge. The eval-judge wraps every untrusted field in a
**per-call random sentinel** (12 hex chars from `crypto.getRandomValues`),
so an attacker cannot pre-write the closing marker:

```
Sample input <<<UNTRUSTED_a3f19c22b704>>>
{inputText}
<<<END_a3f19c22b704>>>

Expected output <<<UNTRUSTED_a3f19c22b704>>>
{expectedText}
<<<END_a3f19c22b704>>>

Agent output <<<UNTRUSTED_a3f19c22b704>>>
{actualText}
<<<END_a3f19c22b704>>>
```

The system prompt classifies everything between the markers as **data,
never instructions**, and tells the judge to score a manipulation attempt
*low* and name it in the rationale. The same fresh-sentinel discipline
covers the transcript digest (`target: transcript`) and the pairwise
comparison prompt (`eval-report diff --pairwise`). The pattern is
borrowed from [`packages/boundary-classifier`](https://github.com/crewhaus/factory/blob/main/packages/boundary-classifier)'s
defense-in-depth.

## Composers

Multiple graders compose:

```typescript
import { all, any, weighted } from "@crewhaus/eval-grader";

const composed = all([
  startsWithDigit,
  underWordLimit({ max: 20 }),
  factuallyAccurate
]);
```

| Composer    | Behavior                                                          |
| ----------- | ----------------------------------------------------------------- |
| `all([...])`   | `passed` if all pass; `score` is the min.                          |
| `any([...])`   | `passed` if any passes; `score` is the max.                         |
| `weighted([{grader, weight}], threshold)` | `score` is weighted average; `passed` is `score >= threshold`. |

> **These are the PROGRAMMATIC composers, and they are not the YAML
> policy.** `all([...])`'s score is the **minimum**; the YAML
> `combine: all` mode's score is the **unweighted mean** of the graders'
> scores (`passed` is the AND either way). If you're writing a
> `graders.yaml`, reach for the top-level `combine:` /
> `passing_threshold:` / per-grader `weight:` keys
> ([Recipe 12 §Combination policy](12-eval-harness.md#combination-policy-combine)),
> not these functions.

When to use each:

- **`all`** — every check is a hard requirement. Tightest gate.
- **`any`** — at least one path works. For "either string match OR
  semantic match" type checks.
- **`weighted`** — soft scoring with priorities. The right tool for
  "faithfulness is 60% of the score; safety is 30%; brevity is 10%."

## The grader registry

[`packages/grader-registry`](https://github.com/crewhaus/factory/blob/main/packages/grader-registry):

```typescript
import { GraderRegistry } from "@crewhaus/grader-registry";

const registry = new GraderRegistry();
registry.register("my_grader", myGraderFactory({ threshold: 0.8 }));

const g = registry.lookup("my_grader");
console.log(registry.list());   // ["my_grader"]
```

A bare `new GraderRegistry()` starts **empty** — the eight bundled
namespaces below live on the runner's `defaultGraderRegistry()`
(`packages/eval-runner/src/default-registry.ts`), which is what
`crewhaus eval` constructs and what a `graders.yaml` resolves against.

Registered names are reached from a `graders.yaml` through a
`type: registry` entry — construction options go under `opts:`, never
as sibling keys (the entry schema is `.strict()`, so a stray
`threshold:` beside `grader:` is a loud parse error):

```yaml
graders:
  - name: close_enough       # the report label
    type: registry
    grader: my_grader        # the REGISTERED name
    opts: { threshold: 0.8 } # construction options
```

The registry is **per-process** — registrations don't persist.
Wiring happens at runtime startup (a plugin discovery pass, or a
direct `register()` call in your codebase).

## Plugin discovery

For graders shared across a harness, put them under the harness's
`.crewhaus/graders/<plugin-name>/` — the **one** discovery root, rooted
at the runner's cwd (there is no home-directory plugin root):

```
<harness>/.crewhaus/graders/
  my-team-graders/
    index.ts
    package.json
```

`index.ts` default-exports `{ name, grader }` (or an array of them):

```typescript
export default [
  { name: "team_specific_grader_1", grader: myGrader1 },
  { name: "team_specific_grader_2", grader: myGrader2 }
];
```

`discoverPluginGraders(registry, "<harness>/.crewhaus/graders")` walks
the root, dynamically imports each plugin's `index.{ts,js,mjs}`, and
**upserts** each entry — so a plugin registering a pack's name (say
`safety.toxicity`) deliberately **overrides** the pack. A missing or
malformed default export is a loud `GraderRegistryError`, never a
silently skipped grader.

The discovery runs when the default registry is built, at the start of
every `crewhaus eval` run — plugins are picked up automatically, with no
per-spec wiring.

## Pack opts are strictly validated at run start

The eight registry namespaces (`continuity.*`, `twelve.*`, `nlg.*`,
`semantic.similarity`, `multimodal.*`, `safety.*`, `calibration.*`,
`consistency.*`) each declare a **strict** options vocabulary. An unknown
or out-of-range key is a loud error **at run start**, naming that pack's
accepted keys — never a silently-defaulted grade:

| Pack | Accepted `opts` |
| ---- | --------------- |
| `nlg.rouge1/2/L`, `nlg.bleu1..4` | `threshold` (0..1), `reference`, `lowercase` |
| `nlg.meteor` | the above + `alpha` (0..1), `beta` (≥0), `gamma` (≥0) |
| `semantic.similarity` | `embedder` (a model spec string), `threshold`, `reference`, `disableFallback`, `fallbackThreshold` |
| `multimodal.imageSimilarity` | `threshold` (0..1), `hashSize` (int, 1..16) |
| `multimodal.imageOcrThenGrade` | `model`, `textGrader` (default `nlg.rougeL`), `lang` |
| `safety.piiLeak` | `threshold` (0..1) |
| `safety.toxicity` / `safety.bias` | `classifier`, `threshold` |
| `safety.toxicity.heuristic` / `safety.bias.heuristic` | `threshold` (0..1) — the mock classifier is fixed, only the gate is tunable |
| `calibration.abstentionAware` | `mode: exact\|contains`, `caseInsensitive` |
| `consistency.paraphraseGroup`, `twelve.*`, `continuity.*`, `multimodal.audioTranscriptMatch` | **none** — an `opts:` block loud-rejects |

Two wiring notes worth knowing before you write a plugin to replace a
pack:

- **`safety.toxicity` / `safety.bias` are reachable now.** The
  judge-backed classifier resolves lazily from `CREWHAUS_EVAL_CLASSIFIER`
  (a judge model spec) or `opts.classifier`. For an offline run, the
  honest keyword mocks live under the **explicit** names
  `safety.toxicity.heuristic` / `safety.bias.heuristic` — never a silent
  default for the real names.
- **`multimodal.audioTranscriptMatch` still throws** a
  wiring-explaining `GraderError`: no bundled adapter carries audio
  input, so there is no STT env var to set. A plugin (or a programmatic
  `SttFn`) is the only route. Its sibling
  `multimodal.imageOcrThenGrade` *is* wired, via
  `CREWHAUS_EVAL_VISION_MODEL` or `opts.model`.

## Meta-eval: is your grader any good?

A grader is a measurement instrument, and an unmeasured instrument is a
guess. `crewhaus graders test` replays every grader in a config over
human-adjudicated golden verdicts:

```bash
crewhaus graders test --graders eval/graders.yaml \
  --golden eval/golden-verdicts.jsonl --min-agreement 0.85
```

Each golden line is strict JSONL —
`{"id","input","agent_output","expected_passed","expected_score"?}` —
and a stray key or duplicate id is a loud, line-numbered error. Per
tested grader you get the agreement rate, **Cohen's kappa** vs
`expected_passed`, false positives/negatives with up to 5 exemplar ids
each, abstained/error counts (excluded from the denominator), and mean
absolute score error when `expected_score` is present.
`--min-agreement F` exits non-zero when any **tested** grader falls
below the floor.

Boundaries stated plainly: deterministic and registry graders replay
**credential-free**; `llm_judge` graders need visible judge credentials
and are **skipped with a notice** without them (the rest still test);
`target: transcript` judges **always** skip, because a golden verdict
carries only the final output. Judge rubrics test at their **declared**
`passing_score` — the `judge calibrate --apply` overlay is deliberately
not applied, because the meta-eval measures the file as written.

To document the instrument for a release PR:

```bash
crewhaus graders card --graders eval/graders.yaml -o eval/RUBRIC-CARD.md
crewhaus graders card --template rag        # read a family before scaffolding it
```

The card is deterministic — no timestamps, identity is the config's
`gradersHash` — so a card diff shows real instrument changes only, and
carding a template family then carding the scaffolded copy proves the
copy is unedited.

## Wiring against production grader families

For hybrid graders, compose your custom check with bundled ones:

```typescript
import { all } from "@crewhaus/eval-grader";
import { createEmbedder } from "@crewhaus/embedder";
import { GraderRegistry } from "@crewhaus/grader-registry";
import { rougeL } from "@crewhaus/grader-nlg-metrics";
import { semanticSimilarity } from "@crewhaus/grader-semantic-similarity";
import { piiLeak } from "@crewhaus/grader-safety-classifiers";

const productionGrader = all([
  rougeL({ threshold: 0.6 }),
  semanticSimilarity({
    embedder: createEmbedder({ model: "openai/text-embedding-3-small" }),
    threshold: 0.85,
  }),
  piiLeak(),
  myCustomBusinessLogicGrader
]);

const registry = new GraderRegistry();
registry.register("production", productionGrader);
```

Note the option names: the code API takes an `embedder` **object**
(`createEmbedder({ model })`), while the YAML `opts: { embedder: "…" }`
takes the model **spec string** and constructs the embedder for you.
The safety pack exports `toxicity(opts)` / `bias(opts)` /
`piiLeak(opts)`, each taking a `Classifier` where one is needed.

The four bundled grader families ([`packages/grader-nlg-metrics`](https://github.com/crewhaus/factory/blob/main/packages/grader-nlg-metrics),
[`grader-semantic-similarity`](https://github.com/crewhaus/factory/blob/main/packages/grader-semantic-similarity),
[`grader-safety-classifiers`](https://github.com/crewhaus/factory/blob/main/packages/grader-safety-classifiers),
[`grader-multimodal`](https://github.com/crewhaus/factory/blob/main/packages/grader-multimodal)) cover the
standard checks; your custom grader fills in the domain-specific
piece.

**`semantic.similarity`'s fallback is loud now.** It still degrades per
sample to a ROUGE-L verdict when the embedder errors, but the *run* also
reports the instrument swap: `aggregates.semanticFallback`
(`{sampleCount, sampleIds, embedderError}`) plus an
`[eval] warning: N sample(s) graded by ROUGE-L fallback …` on stderr.
Set `opts: { disableFallback: true }` to turn an embedder error into a
loud grader failure instead.

## Testing graders

Two test styles:

### 1. Fixture-based — deterministic

```typescript
test("starts_with_digit passes 'fix' → '5 things'", async () => {
  const verdict = await startsWithDigit(
    { id: "s1", input: "Tell me numbers", expected_output: "5 things" },
    { agentOutput: "5 things to remember" }
  );
  expect(verdict.passed).toBe(true);
  expect(verdict.score).toBe(1);
});

test("starts_with_digit fails 'fix' → 'five'", async () => {
  const verdict = await startsWithDigit(
    { id: "s2", input: "Tell me numbers", expected_output: "5 things" },
    { agentOutput: "five things to remember" }
  );
  expect(verdict.passed).toBe(false);
});
```

### 2. Property-based — invariants

```typescript
test("score is monotonic in input length", async () => {
  for (let len = 10; len < 100; len++) {
    const text = generateText(len);
    const v1 = await myGrader(sample, { agentOutput: text });
    const v2 = await myGrader(sample, { agentOutput: text + " more" });
    expect(v2.score).toBeGreaterThanOrEqual(v1.score - 0.01);  // allow small wobble
  }
});
```

Useful for graders that should "stay consistent" — small input changes
shouldn't cause large score swings.

## Using a grader as a canary gate

The regression runner ([Recipe 21](21-deployment-and-canary.md))
uses graders as the auto-rollback signal via its `gate()` API — the
canary-gate source of truth in
[`packages/regression-runner`](https://github.com/crewhaus/factory/blob/main/packages/regression-runner):

```typescript
import { loadRun } from "@crewhaus/eval-report";
import { gate } from "@crewhaus/regression-runner";

const prev = await loadRun(".crewhaus/evals/run-1");
const next = await loadRun(".crewhaus/evals/run-2");

const result = gate(prev.summary, next.summary, {
  regressionThreshold: 0.02,  // ≤2-point pass-rate drop allowed (default 0.05)
  latencyThreshold: 500,      // ≤500ms p95 drift allowed (default 5000)
  scoreShiftEpsilon: 0.1,     // DEFAULT_SCORE_EPSILON — same constant the diff uses
});
// result: { verdict: "pass" | "fail", reason?, report }
```

It reads two eval-run summaries, computes the deltas, and gates on the
thresholds. A grader that returns useful score gradients (not just 0/1)
is much more useful here than a binary gate — it lets the canary detect
quality regression before it becomes a pass-rate regression.

`scoreShiftEpsilon` defaults to `DEFAULT_SCORE_EPSILON` — the **one**
literal `@crewhaus/eval-runner` exports and `eval-report diff --epsilon`
defaults to, so the diff a human reads and the gate that blocks can't
drift apart.

## Driving prompt optimization

The prompt-optimizer ([Recipe 42](42-active-optimization.md)) uses
the grader as the **fitness function** for spec patches — the graders
config is passed as a file, and there is no `--grader <name>` flag:

```bash
crewhaus optimize my-spec.yaml \
  --dataset eval/dataset.jsonl --graders eval/graders.yaml
```

The optimizer mutates whitelisted spec fields (`OPTIMIZABLE_PATHS`) and
scores each variant through the same eval-runner stack. Higher score →
keep the patch.

A well-tuned grader makes the optimizer effective; a binary grader
gives the optimizer no gradient to follow. Prefer continuous-score
graders for optimization workflows.

One boundary the optimizer states in `--help`: the fitness eval grades
each candidate on `input` + `expected_output` **only** — a sample's
`expected_tools` and `metadata` are stripped inside the search loop, so
tool-accuracy graders and slice reporting apply at the `crewhaus eval`
gate, not during the search. Samples pinned into
`<spec>-regressions` keep their original fields, so the gate grades them
in full.

## Things that look like a grader but aren't

| Symptom                                                            | Better tool                                    |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Want to **check the agent's tool sequence**, not its output.        | `tool_call_sequence` bundled grader.            |
| Want the sample's **own gold as the needle**.                       | `expected_contains` — no plugin needed.         |
| Want to **score multimodal output** (image + text).                 | `grader-multimodal`.                            |
| Want to separate **wrong** from **didn't attempt**.                 | the `calibration.abstentionAware` registry pack. |
| Want to **monitor live traffic**, not just eval datasets.           | Per-call OTel metrics ([Recipe 17](17-observability.md)). |
| Want to **A/B test prompts**.                                       | Eval-runner + canary.                            |
| Want to know whether your **grader** is right.                      | `crewhaus graders test` (above), not another grader. |

## What to read next

- **Using your grader as a canary gate.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **Driving prompt optimization with your grader.** [Recipe 42 — Active Optimization](42-active-optimization.md).
- **Eval harness end-to-end.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Running graders in CI tiers, with cassettes and a review queue.** [Recipe 74 — Eval suites, cassettes, red teams](74-eval-suites-and-cassettes.md).

## Pointers to source

- **Core graders + the `graders.yaml` schema:** [`packages/eval-grader`](https://github.com/crewhaus/factory/blob/main/packages/eval-grader) (`src/graders-config.ts`).
- **LLM-as-judge:** [`packages/eval-judge`](https://github.com/crewhaus/factory/blob/main/packages/eval-judge).
- **Registry:** [`packages/grader-registry`](https://github.com/crewhaus/factory/blob/main/packages/grader-registry).
- **The default registry, pack opts schemas, and plugin discovery:** [`packages/eval-runner/src/default-registry.ts`](https://github.com/crewhaus/factory/blob/main/packages/eval-runner/src/default-registry.ts).
- **Production graders:** [`packages/grader-nlg-metrics`](https://github.com/crewhaus/factory/blob/main/packages/grader-nlg-metrics), [`packages/grader-semantic-similarity`](https://github.com/crewhaus/factory/blob/main/packages/grader-semantic-similarity), [`packages/grader-safety-classifiers`](https://github.com/crewhaus/factory/blob/main/packages/grader-safety-classifiers), [`packages/grader-multimodal`](https://github.com/crewhaus/factory/blob/main/packages/grader-multimodal).
- **Module catalog reference:** §16, §29, §38 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
