# Recipe 61 — Self-building evals for any shape

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `scaffold-evals`, `eval-coverage`, `dataset-miner`, `dataset-synthesizer`, `grader-suggest`, `eval-bridge-emitter`.
**Shipped:** crewhaus 0.2.0 (`crewhaus scaffold-evals`, `eval coverage`, `dataset mine`/`synthesize`, `graders suggest`, `compile --with-eval-harness`); extended in 0.4.x (`scaffold-evals --template`, `eval coverage --graders`, `dataset lint`/`audit`, `graders test`/`card`, `datasets verify`/`status`/`release`/`card`, and eval bridges for the multi-stage shapes).

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

### Or start from a first-party template family

If your task is a recognizable *kind* of task, `--template <family>`
copies a fully-anchored graders file instead of drafting one:

```bash
crewhaus scaffold-evals crewhaus.yaml --template rag -o eval
crewhaus graders card --template rag        # read what it measures FIRST
```

Six families, exactly: **`rag | summarize | extract | support | safety |
classify`**. An unknown name lists the available ones instead of
guessing. The command copies the family's `graders.yaml` verbatim under
a provenance header and seeds `dataset.jsonl` from the family's samples,
topped up to `--samples N` with spec-derived stubs.

Two boundaries stated plainly:

- **This path is OFFLINE by construction.** `--model` is **refused**
  with `--template`: the families are embedded static module content, so
  nothing is fetched and nothing is signature-verified here.
- **`classify` is the exception to the top-up.** Every grader in that
  family needs a gold, so its dataset stops at the gold-carrying seeds
  (no stub top-up) and says why.

Carding the family and then carding the scaffolded copy is how you prove
the copy is unedited — the card's identity is the config's
`gradersHash`, with no timestamps.

> **Not wired yet, deliberately.** The `@crewhaus/template-registry`
> manifest grammar gained `kind: "grader-template"` and an `evalAssets`
> block (both appended **append-only** to the signing payload, so
> existing signatures keep verifying, and `templates list` marks such a
> manifest `[eval-template]`). But `templates use` **refuses** an
> eval-asset template, and `scaffold-evals --template` resolves **only**
> the embedded first-party families — no registry fetch, and nothing on
> this path reads `CREWHAUS_TEMPLATE_REGISTRY`.

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

**`--graders` is real now** (it used to be accepted and ignored). Passing
it adds the *grader*-side of coverage:

```bash
crewhaus eval coverage --sessions all --graders eval/graders.yaml
```

- how many samples each grader can **actually score** (gold-needing vs.
  gold-less — sharing `dataset lint`'s own predicate, so the two
  surfaces cannot disagree);
- which declared graders **no recent run ever recorded**;
- which judge **criteria never varied** across the last few runs'
  persisted per-criterion grades — a dead criterion pays judge tokens
  and can never change a verdict.

Omitting the flag leaves every rendered byte unchanged. Note that
`eval coverage` deliberately inspects a bare registry ref across **all**
splits, test included: gap analysis over a partial record would
misreport.

## Keep the dataset honest: `dataset lint` and `dataset audit`

Two offline verbs, no model calls, that belong in CI beside the eval
itself:

```bash
crewhaus dataset lint --dataset registry:support-agent-ratings --strict
crewhaus dataset lint --all --strict          # every registered dataset's latest version
crewhaus dataset audit --pii --dataset registry:support-agent-ratings --strict
```

`dataset lint` **errors** on duplicate sample ids, empty-string golds, a
gold-needing grader (`exact_match` / `expected_contains`) over a dataset
where **no** sample carries a gold, and any `--canary` phrase found in
`crewhaus.yaml` or a `.crewhaus/fewshot` pool (that is contamination,
full stop). It **warns** on near-duplicate inputs (normalized token
overlap ≥ 0.9), ids reused with *different* content in other versions of
the same registry dataset, and a `metadata.source` outside the
provenance taxonomy. `--strict` exits non-zero on any finding.

`crewhaus eval` runs a **lint-lite preflight** of the two most expensive
findings before any model spend: duplicate ids and the
all-gold-less × gold-needing-graders mismatch **refuse the run**;
partial gold gaps warn and proceed. `--no-preflight` skips it.

`dataset audit` is the PII/secret pass, regex detectors only — the same
shared set `dataset synthesize` and `fewshot harvest` redact with. The
report counts hits per detector/field/sample id and **never echoes the
matched text**. It is multi-turn aware (history message contents scan as
`history[<i>].content`). `--apply` requires a `registry:` ref and writes
redacted samples as a **new auto-bumped version**, preserving the
record's split structure exactly — never in place, never re-split. A
registry ref **without** `#split` is scanned across **all** splits, test
included: inspection is not consumption.

### The provenance taxonomy

`metadata.source` is canonical and enforced — **exactly five** members:
`human_authored | production_log | synthetic | synthetic_human_verified
| canary`. Two behavior changes worth knowing:

- `dataset synthesize` now stamps `source: "synthetic"` (it used to
  stamp the tool-named `"synthesize"`), and `distill` stamps
  `source: "production_log"` with the rating channel preserved as the
  new `metadata.feedback_source`. Default `--slice source` labels and
  provenance reports shift accordingly.
- The registry enforces one hard invariant at `put`: a
  `source: "synthetic"` sample carrying an `expected_output` is
  **refused**, with a pointer to `synthetic_human_verified`. A
  human-verified gold is a different artifact from a generated one, and
  `dataset refresh-goldens --apply` retags exactly that way.

`registerDataset` warns on stderr (never fails) when declared provenance
falls outside the taxonomy, listing the offenders.

## Document and gate the dataset itself

```bash
crewhaus datasets verify support-agent-ratings          # content hashes vs. what put recorded
crewhaus datasets status support-agent-ratings --runs 10
crewhaus datasets card   support-agent-ratings -o eval/DATASHEET.md
crewhaus datasets release support-agent-ratings \
  --spec crewhaus.yaml --graders eval/graders.yaml      # the sanctioned holdout spend
```

- **`verify`** recomputes every split's per-sample content hashes and
  compares them to what the record stored at `put`. Version omitted →
  every version. Offline, and **exits non-zero on any mismatch**, which
  makes it a CI gate: a hand-edited version has silently diverged from
  its own eval-history identity.
- **`status --runs N`** (default 10) joins registry versions with the
  run-history index: per-version age, indexed-run count per version and
  when last, how many runs consumed the locked `#test` split, and the
  test-split **burn count**. Its saturation signal names **rotation
  candidates** — sample ids that appeared in ≥2 of the last N joined runs
  and passed **every** time are no longer measuring anything.
- **`card`** writes a markdown datasheet: split sizes + sample-hash
  counts, the all-splits content hash, `createdAt` + age, provenance
  breakdown by `metadata.source` (percentages, untagged counted),
  indexed eval-run count, full release/burn history, and an embedded
  offline lint summary. It never mutates the record.
- **`release`** is the sanctioned way to spend the holdout: it runs
  `crewhaus eval` over the version's locked `#test` split (threading
  `--allow-test-split`, with the **regression union skipped** so the
  holdout stays pure) and appends a `{version, runId, ts, passRate}`
  entry to the record. A version whose test split was already released
  **refuses a second release without `--force`**, which warns that a
  re-run holdout score is no longer a first look.

Contamination tripwires are one flag: `crewhaus datasets put <name>
--file <f> --canary` injects exactly **one** canary sample whose input is
a deterministic 32-hex phrase derived from the (name, version) hash — no
wall clock — tagged `metadata.source: "canary"` and carrying **no gold**.
The runner excludes canaries from the pass-rate denominator and lists
them separately; `dataset lint` scans your spec and few-shot pools for
the phrase.

## Grow the dataset from real usage

Two `dataset` (singular) subcommands grow the set without hand-writing
samples.

**`dataset mine`** pulls hard cases from session struggle signals into a
quarantine, then promotes the ones you accept into a mined registry
dataset:

```bash
crewhaus dataset mine --sessions all --review
```

`--review` promotes accepted candidates. In a non-TTY (CI), `--review`
alone prints the list; add `--yes` to promote non-interactively — the
tool never silently auto-accepts. Mined candidates also enqueue
**pointers** into the review queue (`crewhaus review list --kind
quarantine`, [Recipe 74](74-eval-suites-and-cassettes.md#part-4--the-review-queue))
— the quarantine JSONL stays the payload store.

The signal union is `tool-error | error | loop | retry | egress-block |
eval-fail`. The last one is new: an in-loop `evaluation:` judge failure,
read from each session's **trace sidecar** `<id>.events.jsonl` (the
durable event log carries no `eval_graded` kind). A turn the
`on_fail: retry` ladder **recovered** is deliberately **not** harvested;
one that burned the ladder and still failed is flagged
`eval_retries_exhausted` and ranks just below `error` in dedupe, with the
judge score, threshold and grader riding into the quarantine sample's
metadata. See [Recipe 66](66-eval-in-loop.md).

That last signal is **opt-in**: the sidecar exists only for runs that had
`CREWHAUS_WATCHME=1` set (a compiled `cli`/`channel` bundle stamps it when
the spec carries `watchme: {enabled: true, capture: full}`; `crewhaus run`
also stamps it after `crewhaus watchme start`; the managed daemon does not
stamp it yet). With watchme off you get zero `eval-fail` candidates even
with `evaluation:` wired — `mine` prints how many scanned sessions carried
a sidecar so you can tell "none captured" from "none failed".

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
one. Variants are stamped `source: "synthetic"`, and paraphrase variants
(template **and** model) additionally carry
`metadata.paraphrase_group` = the parent sample's id — which is what the
`consistency.paraphraseGroup` grader pack measures. Truncate, ambiguate
and inject variants deliberately change the question and stay
group-less. A bare `--from registry:<name>` resolves train+dev, and
`#test` is refused.

> For an **adversarial** suite rather than stress variants of your own
> inputs, `crewhaus redteam generate` builds a behavior-taxonomy attack
> corpus against your agent — deterministic, offline, and never unioned
> into a gate. [Recipe 74](74-eval-suites-and-cassettes.md#part-3--red-team-probes).

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

It reconciles a bare ref against **train+dev only**, and `--apply`
patches golds **within** the record's existing split structure — never
re-splitting — so unselected splits (test included) pass through
byte-identically.

**Ingestion redacts by default now (behavior change).** `crewhaus
distill`, the unattended `feedback.autoDistill` teardown, and `crewhaus
dataset mine` all run the same PII/secret detector set over every
free-text field at sample construction, deterministically replacing hits
with `[REDACTED:<kind>]` and leaving non-PII text byte-identical.
`--no-redact` opts out on `distill`, `dataset mine`, and
`optimize --ratings` — but **not** on the autoDistill teardown, which is
unattended and always redacts.

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

Then **measure the grader you just drafted** before letting it gate
anything — `crewhaus graders test` replays every grader over
human-adjudicated golden verdicts and reports agreement + Cohen's kappa
per grader, with `--min-agreement F` as a CI gate
([Recipe 34](34-building-custom-graders.md#meta-eval-is-your-grader-any-good)):

```bash
crewhaus graders test --graders eval/graders.yaml \
  --golden eval/golden-verdicts.jsonl --min-agreement 0.85
crewhaus graders card --graders eval/graders.yaml -o eval/RUBRIC-CARD.md
```

Calibrate an LLM judge against your accumulated human ratings so its
score threshold matches human judgment:

```bash
crewhaus judge calibrate --graders eval/graders.yaml --sessions all --apply
crewhaus judge calibrate --graders eval/graders.yaml \
  --dataset registry:support-agent-ratings --apply
```

`--apply` persists the calibrated `--min-score` default to
`.crewhaus/judge-calibration.json` — **atomically** now (temp file +
rename, rather than truncate-then-write; a torn file had been silently
mis-gating whole runs).

**`--dataset` is real now** — it was declared, shown in help, and never
read. It **adds** calibration pairs from the golden verdicts a distilled
dataset carries, combined with the session-ratings pairs that remain the
default path. The pairing contract is exact: a sample pairs when
`metadata.user_rating` is a number in [0,1] **and** `expected_output` is
the non-empty answer that rating was placed on. Deliberately skipped as
mis-paired: `metadata.correction` (there the gold is the *human's*
correction, not what was rated) and `metadata.gold_refreshed`; samples
already paired from scanned sessions are dropped as duplicates. A
`--dataset` yielding **zero** usable pairs **dies loudly** with the
contract spelled out. Registry refs resolve train+dev on a bare ref —
the locked test split stays locked.

If your only `llm_judge` entries use **categorical** rubrics, calibrate
now explains that a label-gated rubric has no scalar cut to calibrate.

## Eval bridges: put a non-cli shape in the flywheel

Here's the big unlock. `crewhaus eval` runs `target: cli`. That meant
every other shape — workflow, graph, channel, crew, research, batch,
… — couldn't consume its own distilled feedback. The flywheel was a
CLI-only story.

`compile --with-eval-harness` fixes it: alongside the normal bundle it
emits an **eval bridge** into `<out-dir>/eval/`. The shape can now be
evaluated, optimized, and flywheeled through that bridge:

```bash
# Compile a workflow AND emit its eval bridge:
crewhaus compile crewhaus.yaml -o dist --with-eval-harness
ls dist/eval/          # the emitted eval entry
```

Point `--eval-dataset <name>` at the dataset the bridge consumes
(defaults to `<specName>-eval`):

```bash
crewhaus compile crewhaus.yaml -o dist \
  --with-eval-harness --eval-dataset support-workflow-eval
```

### The bridge drives the REAL runtime now

The old bridge projected a non-cli shape onto a single-turn chat agent —
which measured an impersonation, not the thing you ship. **The
`per-step eval bridges are not yet supported` rejection is lifted for
`workflow`, `graph`, `crew`, and `pipeline`**, and a bridged bundle now
drives the shape's *actual compiled runtime*:

| Shape | What the bridge drives |
| ----- | ---------------------- |
| `workflow` | the compiled step sequence end-to-end (`sample.input` is the step-1 trigger; the **final** step's output is graded; step trace events land in `RunResult.events`) |
| `graph` | the compiled graph to `run_done` on a per-sample RunContext (final state JSON graded; **HITL pauses fail the sample loudly**) |
| `crew` | one crew turn through the compiled orchestrator + roles with the daemon's own run options (`crew_done.finalOutput` graded, crew transcript captured) |
| `pipeline` | the indexed agent + Retrieve tool (module-scope indexing runs once at entry import — the deployed boot) |
| `channel` | loopback-delivers the inbound message through the bot's real `runTurn` (inbound classification + session resume; a sample's `history` pre-seeds the session transcript so the real resume path replays it) |
| `managed` | the gateway's existing `runOneTurn` dispatcher under an **isolated per-sample tenant** |
| `voice`, `onchain`, `onchain-game`, `batch`, `research`, `browser` | a single-turn loop over the agent's **real wired tools**; each fidelity gap is named in the per-shape strategy the compile prints |

Still rejected: **`cli`** (use `crewhaus eval` directly) and
`--emit-as cf-worker` alongside the bridge.

**A plain compile stays byte-for-byte identical.** Under the flag, the
workflow/graph/pipeline bundle gains an exported `runForEval` entry (its
CLI main is guarded by `import.meta.main`), crew/channel bundles gain an
`eval-entry.ts`, and the channel bundle's `agent.ts` gains two
flag-gated seams — `AgentConfig.fabricRoot` (per-sample memory/continuity
isolation) and the `_adapter` scripted-provider hook.

**Behavior change — `history` seeds only chat-capable shapes**
(channel / managed / voice / pipeline). A history-carrying sample against
any other bridged shape **fails loudly at dataset load**, rather than
silently seeding a conversation into a runtime that consumes one trigger
input.

For every non-cli shape this is how you bring the whole
self-improvement loop from Recipe 56 to a harness that isn't a CLI — and
[`crewhaus optimize --stage`](42-active-optimization.md#multi-stage-specs-and---stage)
optimizes those shapes stage by stage through the same bridge.

## The self-building pipeline, in order

```
scaffold-evals [--template <family>]  → day-one dataset + grader
dataset lint --strict                 → offline hygiene + canary leak scan
eval coverage [--graders]             → which behaviors/graders have no eval
dataset mine --review                 → hard cases from real struggle
dataset synthesize                    → stress variants (separate split)
redteam generate                      → an adversarial suite you never wrote
graders suggest → graders test        → drafted from failures, then MEASURED
judge calibrate --apply               → the judge's cut matches human taste
dataset refresh-goldens --apply       → keep golds honest over time
datasets verify | status | card       → is the dataset still an instrument?
datasets release                      → spend the holdout, once, on the record
review next                           → what the judges could not decide
eval suite --tier fast|nightly|release → the CI ladder, one verdict per rung
compile --with-eval-harness           → bring non-cli shapes into the loop
   └──►  feed it all into the flywheel (Recipe 56)
```

The last four rungs are [Recipe 74](74-eval-suites-and-cassettes.md).

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
- **`scaffold-evals --template` when your task has no matching family.**
  Six families exist and an unknown name is refused; drafting from the
  spec is the general path.
- **`datasets release` more than once per version.** It refuses without
  `--force`, and it's right to: a re-run holdout score is no longer a
  first look.

## What to read next

- **The flywheel this feeds.** [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md).
- **The dataset + grader format.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Custom grader kinds.** [Recipe 34 — Building Custom Graders](34-building-custom-graders.md).
- **CI tiering, cassettes, red teams, review queue.** [Recipe 74 — Eval suites, cassettes, red teams](74-eval-suites-and-cassettes.md).

## Pointers to source

- **Eval runner:** [`packages/eval-runner`](https://github.com/crewhaus/factory/blob/main/packages/eval-runner).
- **Dataset registry:** [`packages/dataset-registry`](https://github.com/crewhaus/factory/blob/main/packages/dataset-registry).
- **Distill / synthesis:** [`packages/eval-optimizer-orchestrator`](https://github.com/crewhaus/factory/blob/main/packages/eval-optimizer-orchestrator).
- **Eval-template families:** [`packages/template-registry/src/grader-templates.ts`](https://github.com/crewhaus/factory/blob/main/packages/template-registry/src/grader-templates.ts).
- **Bridge emission + runtime helpers:** [`packages/target-eval-bundle`](https://github.com/crewhaus/factory/blob/main/packages/target-eval-bundle).
- **Module catalog reference:** §16, §29, §38 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
