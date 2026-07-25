# hello-optimize

The smallest possible demonstration of Pillar 2 — active eval optimization: an
eval that fails, an optimizer that rewrites the prompt, and a spec patch that
makes it pass.

## The experiment

| file | what it holds |
|---|---|
| `crewhaus.yaml` | `agent.instructions: Answer the user's question.` — terse on purpose |
| `dataset.jsonl` | 10 capital-of-X questions whose `expected_output` is the machine line `capital=<City>` |
| `graders.yaml` | `contains` for the `capital=` marker, `exact_match` for each sample's own `expected_output` |

The dataset is the contract; the prompt never mentions it. So the agent answers
every question **correctly, in prose**, and scores **0.0%** — right city, wrong
shape, unusable by whatever was going to parse that line. Closing that gap is
the optimizer's job, and the gap is what makes the lift measurable.

## Run it

This starter is self-contained — run it from its own directory:

```bash
cd starters/optimize       # if you copied it elsewhere, cd into that copy
export ANTHROPIC_API_KEY=sk-ant-...   # or ANTHROPIC_AUTH_TOKEN

# 1 — measure the baseline: 10 samples, 2 graders, 0.0%
bunx crewhaus eval crewhaus.yaml \
  --dataset dataset.jsonl \
  --graders graders.yaml

# 2 — let the Claude mutator rewrite the prompt from the graders' rationale
bunx crewhaus optimize crewhaus.yaml \
  --dataset dataset.jsonl \
  --graders graders.yaml \
  --iterations 3 \
  --mutator claude

# 3 — same run, but apply the winner to crewhaus.yaml
bunx crewhaus optimize crewhaus.yaml \
  --dataset dataset.jsonl \
  --graders graders.yaml \
  --iterations 3 \
  --mutator claude \
  --write-back

# 4 — re-measure: the same 10 samples, now at 100%
bunx crewhaus eval crewhaus.yaml \
  --dataset dataset.jsonl \
  --graders graders.yaml
```

Each run writes its report and per-sample transcripts under
`.crewhaus/evals/<runId>/` and records itself as the baseline the next run is
compared against — which is where the `recoveries=10` line below comes from.

Step 3 edits `crewhaus.yaml` in place (with a provenance header naming the run
id and the delta) — `git checkout starters/optimize/crewhaus.yaml` puts the
terse prompt back.

> `bunx crewhaus` resolves the published CLI, so this works after the
> starter is copied anywhere — no repo checkout required. (Install it
> once with `npm i -g crewhaus`, Homebrew, Scoop, winget, or apt — see
> the [demos README](https://github.com/crewhaus/demos#run).)

## Measured — CLI 0.4.0, 2026-07-25

`optimize` splits the dataset 70/30 and scores candidates on the 3-sample dev
split; `eval` scores all 10.

| step | result |
|---|---|
| `eval` (baseline) | `pass_rate=0.0% mean_score=0.000 errors=0` — every answer names the right city, none is the contract line |
| `optimize --mutator claude --iterations 3` | `score: 0.000 → 1.000 (Δ +1.000)`, `spend: ~$0.011 over 3 model call(s)`, `patch ready (improvement ≥ 0.01)` — the first candidate already scores 1.000 |
| `… --write-back` | `wrote patched YAML to …/crewhaus.yaml` — the rewritten instruction states the contract, e.g. *"Answer the user's question using exactly this format: capital=&lt;city_name&gt; … no additional explanation, commentary, or formatting."* (a model writes it, so the wording moves run to run — four consecutive runs here all reached 1.000) |
| `eval` (after) | `pass_rate=100.0% mean_score=1.000`, `recoveries=10` against the baseline run, `gate: PASS` |

The patch is persisted under `.crewhaus/optimize/<runId>/patch.json` regardless
of `--write-back`. The report at `.crewhaus/optimize/<runId>/report.json`
records the score delta, `applied`, the spend, and the timestamp. A winning run
also pins the samples it recovered as a regression dataset under
`.crewhaus/datasets/` (`hello-optimize-regressions@v1`) so a later change cannot
un-fix them quietly.

## Why the default mutator does not move this dataset

`optimize` without `--mutator` uses the deterministic rule-based provider,
whose whole mutation space is four canned edits: append *"Be concise and
direct."*, paste one training sample as an `Example:` block, swap that example
for another, or prepend *"Think step by step before answering."* None of them
states an output contract, and none of them flips a dev sample here — measured
at `--iterations 5 --seed 42`:

```
[optimize] score: 0.000 → 0.000 (Δ +0.000)
[optimize] no improvement above threshold 0.01; source untouched.
```

That refusal is the gate working: the orchestrator applies a patch only when
`improvement >= 0.01`, so `--write-back` will not edit your spec to say nothing.
Reach for the rule-based provider when you want a seed-reproducible, model-free
search; reach for `--mutator claude` when the fix has to be *invented* — it
reads each failing sample's grader rationale (`expected "capital=Canberra" got
"The capital of Australia is **Canberra**…"`) and writes the instruction that
answers it.

## What this proves

This example is the smallest concrete proof of Pillar 2 in factory's [CLAUDE.md](https://github.com/crewhaus/factory/blob/main/CLAUDE.md): the eval stack can produce a *spec patch* that improves grader pass-rate, not just an HTML report. The patch is the artifact that closes the active-optimization loop — and the before/after eval is what proves the patch was worth applying.

See [walkthroughs/42-active-optimization.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/42-active-optimization.md) for the narrative walkthrough.
