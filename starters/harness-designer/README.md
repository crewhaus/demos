# hello-harness-designer — meta-recipe

A CrewHaus harness that designs OTHER CrewHaus harnesses by interviewing
you about intent.

## Run it

```bash
cd starters/harness-designer          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist
ANTHROPIC_AUTH_TOKEN=... bunx crewhaus run crewhaus.yaml
```

### Where it reads its docs from

The designer consults two checkouts at startup: **demos** for the recipe
catalog, **crewhaus-factory** for the Zod spec schema it validates
generated YAML against. It resolves each one the same way — the env var
first, then a walk up its own parent directories, then a cache in
`~/.crewhaus/` that it clones **only if absent**:

```bash
cp .env.example .env
# from an uncopied starters/harness-designer, the parents are:
#   CREWHAUS_DEMOS_PATH=../..
#   CREWHAUS_FACTORY_PATH=../../../factory
```

Setting both is the fast path — it skips the probe and never touches the
network. Leave them empty and the probe finds the same two directories
when the starter still sits inside the demos checkout; copy the starter
somewhere else with the vars unset and it falls back to
`~/.crewhaus/demos-cache` and `~/.crewhaus/factory-cache`.

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
your choosing, and runs `crewhaus compile --emit-ir` against it as a
validation step before handing it back.

If you have an example dataset (inputs + expected outputs), the
designer will also scaffold an eval and run `crewhaus optimize` to
auto-tune the generated spec.

## What this slice exercises

Catalog modules touched (per factory's [docs/MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):

- F1 `spec-schema`, `spec-parser` (the designer reads its own source-of-truth)
- F2 `compiler-core` (the designer validates generated YAMLs)
- R1 `runtime-orchestrator`, R3 `tool-catalog` (read, write, edit, grep, glob, bash)
- R8 `permission-engine` — `alwaysDeny` on `rm -rf`/`sudo` first (first match
  wins), then an allow-list of the `git` + `bunx crewhaus` calls the
  instructions actually make; every other `Bash` call gates through `ask`.
  Every argument glob uses `**`: a lone `*` compiles to `[^/]*` and stops at
  the first `/`, so `Bash(rm -rf *)` would never match `rm -rf /tmp/x`
- R15 `eval-runner`, `prompt-optimizer` (when the user has a dataset)

See [Recipe 48](https://github.com/crewhaus/demos/blob/main/walkthroughs/48-harness-designer.md) for the full
walkthrough, including three worked dialogues and the rationale behind
the intent-driven interview pattern.
