# hello-cli — minimal vertical slice

The smallest possible end-to-end demonstration of the meta-harness pipeline:
a 7-line spec → compiled to a runnable streaming chat agent.

## Run it

This starter is self-contained — run it from its own directory:

```bash
cd starters/cli            # if you copied it elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check        # writes dist/agent.ts and installs its deps
ANTHROPIC_API_KEY=sk-... bunx crewhaus run crewhaus.yaml   # or: bun dist/agent.ts
```

Type messages, get streaming replies, type `exit` to quit.

> `--check` is what writes the bundle's `package.json` and `bun.lock` on CLI
> 0.4.0 (it also asserts the emitted shape and smoke-boots it). A plain
> `compile -o dist` emits only `agent.ts`, so `bun install --cwd dist` has no
> manifest to install from and exits 1.

> `bunx crewhaus` resolves the published CLI, so this works after the
> starter is copied anywhere — no repo checkout required. (Install it
> once with `npm i -g crewhaus`, Homebrew, Scoop, winget, or apt — see
> the [demos README](https://github.com/crewhaus/demos#run).)

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/cli              # writes starters/cli/dist/agent.ts
bun run run starters/cli                  # opens an interactive REPL
```
</details>

## What this slice exercises

Catalog modules touched (per [MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):
- F1 `spec-schema`, `spec-parser`, `spec-validator`, `ir-model`
- F2 `compiler-core`, `target-cli-bundle`, `codegen-templates`
- F4 `spec-cli`
- R1 `runtime-orchestrator` (single-turn-cycle, no recovery yet)
- R2 `model-adapter` (Anthropic only), `prompt-cache-manager` (system prompt)

## Not yet in the slice

Tools, permission system, multi-layer compaction, MCP integration, hooks,
skills, slash commands, plan mode, subagents, telemetry, eval — these
arrive in subsequent layers (see PART G build dependency order in the
module catalog).
