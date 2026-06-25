# hello-harness-designer — meta-recipe

A CrewHaus harness that designs OTHER CrewHaus harnesses by interviewing
you about intent.

## Run it

```bash
cd starters/harness-designer          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist
ANTHROPIC_AUTH_TOKEN=... bunx crewhaus run crewhaus.yaml
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile harness-designer
bun run run harness-designer
```
</details>

Describe what you want in plain English — e.g. "a Slack bot that
reviews PRs" or "an agent that watches USDC transfers and pings me on
Telegram." The designer interviews you about intent, picks a target
shape from the diagnostic decision tree, writes a complete
`crewhaus.yaml` (with `.env.example` and `README.md`) to a directory of
your choosing, and runs the in-tree compiler against it as a validation
step before handing it back.

If you have an example dataset (inputs + expected outputs), the
designer will also scaffold an eval and run `crewhaus optimize` to
auto-tune the generated spec.

## What this slice exercises

Catalog modules touched (per factory's [docs/MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):

- F1 `spec-schema`, `spec-parser` (the designer reads its own source-of-truth)
- F2 `compiler-core` (the designer validates generated YAMLs)
- R1 `runtime-orchestrator`, R3 `tool-catalog` (read, write, edit, grep, glob, bash)
- R8 `permission-engine` — allow-listed `git` + `bunx crewhaus` subcommands;
  every other `Bash` call gates through `ask`
- R15 `eval-runner`, `prompt-optimizer` (when the user has a dataset)

See [Recipe 48](https://github.com/crewhaus/demos/blob/main/walkthroughs/48-harness-designer.md) for the full
walkthrough, including three worked dialogues and the rationale behind
the intent-driven interview pattern.
