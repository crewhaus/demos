# hello-optimize

The smallest possible demonstration of Pillar 2 — active eval optimization.

The spec ships with a deliberately terse `agent.instructions: "Answer the user's question."`. The included dataset (10 capital-of-X questions) and grader (`contains-expected`) make it easy to see the rule-based optimizer add a `"Be concise and direct."` clarification and improve grader pass-rate.

## Run it

This starter is self-contained — run it from its own directory:

```bash
cd starters/optimize       # if you copied it elsewhere, cd into that copy

# Default: rule-based mutator, emits patch.json + report.json
bunx crewhaus optimize crewhaus.yaml \
  --dataset dataset.jsonl \
  --graders graders.yaml \
  --iterations 5 \
  --seed 42

# Apply the winning candidate directly to crewhaus.yaml
bunx crewhaus optimize crewhaus.yaml \
  --dataset dataset.jsonl \
  --graders graders.yaml \
  --iterations 5 \
  --seed 42 \
  --write-back

# Use Claude-driven mutations (requires ANTHROPIC_AUTH_TOKEN or
# ANTHROPIC_API_KEY)
bunx crewhaus optimize crewhaus.yaml \
  --dataset dataset.jsonl \
  --graders graders.yaml \
  --iterations 5 \
  --mutator claude
```

> `bunx crewhaus` resolves the published CLI, so this works after the
> starter is copied anywhere — no repo checkout required. (Install it
> once with `npm i -g crewhaus`, Homebrew, Scoop, winget, or apt — see
> the [demos README](https://github.com/crewhaus/demos#run).)

The patch is persisted under `.crewhaus/optimize/<runId>/patch.json` regardless of `--write-back`. The report at `.crewhaus/optimize/<runId>/report.json` records the score delta, the patched path, and the timestamp.

## What this proves

This example is the smallest concrete proof of Pillar 2 in factory's [CLAUDE.md](https://github.com/crewhaus/factory/blob/main/CLAUDE.md): the eval stack can produce a *spec patch* that improves grader pass-rate, not just an HTML report. The patch is the artifact that closes the active-optimization loop.

See [walkthroughs/42-active-optimization.md](https://github.com/crewhaus/demos/blob/main/walkthroughs/42-active-optimization.md) for the narrative walkthrough.
