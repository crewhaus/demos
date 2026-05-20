# hello-procode — a pro-grade terminal coding companion in one YAML

A full coding agent — codebase exploration, file editing, test
execution, sub-agent dispatch, safety-gated bash, web research —
compiled from a single [`crewhaus.yaml`](crewhaus.yaml). It feels
tier-one (think Claude Code / Cursor) on the surface and runs against
**any model** (Claude, GPT-4o, Gemini, Bedrock, local) — see
[Swap the model](#swap-the-model) below.

## Run it

From the repo root:

```bash
bun install
bun run compile:hello-procode                          # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-ant-... bun run run:hello-procode # opens REPL in cwd
```

Or, to point it at a specific project, `cd` there first and run the
compiled bundle directly:

```bash
cd ~/my-project
ANTHROPIC_API_KEY=sk-ant-... bun /path/to/demos/hello-procode/dist/agent.ts
```

The agent's CWD is the project under analysis. `.crewhaus/commands/`
and `.crewhaus/skills/` ship inside this demo — drop your own there to
add custom slash commands and skills.

## Try this

Open the REPL, then paste one of these:

```
explore this repo and tell me what it does in 5 bullets
```

```
/init
```
Bootstraps a `CODE-COMPANION.md` at the repo root summarizing the project
so future sessions start with context.

```
/review
```
Runs a security + correctness + style pass over `git diff HEAD`.

```
add error handling to the function that calls the OpenAI API
```
Demonstrates the full Method loop: dispatch `code-explorer` → read the
file → plan → edit → dispatch `test-runner` → verify.

```
/plan migrate this repo from CommonJS to ESM
```
Plan-only mode — produces a multi-step plan without editing anything.

## Swap the model

The `model:` field is a provider-prefixed string. Edit
[`crewhaus.yaml`](crewhaus.yaml) at `agent.model:` to switch:

| Provider | `model:` value | Env var |
|---|---|---|
| Anthropic (default) | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| Anthropic (cheap) | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-4o-2024-11-20` | `OPENAI_API_KEY` |
| Google | `gemini-2.0-flash` | `GOOGLE_API_KEY` |
| AWS Bedrock | `bedrock/anthropic.claude-sonnet-4-20250514-v1:0` | `AWS_*` |
| Local (OpenAI-compatible) | `local/llama-3.3-70b@http://localhost:8080/v1` | — |

Recompile (`bun run compile:hello-procode`) after any change to the spec.

## What this slice exercises

Catalog modules touched (per factory's
[docs/MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):

- F1 `spec-schema`, `spec-parser`, `spec-validator`, `ir-model`
- F2 `compiler-core`, `target-cli-bundle`, `codegen-templates`
- R1 `runtime-orchestrator` (streaming chat loop, session persistence)
- R2 `model-adapter` (provider-agnostic), `prompt-cache-manager`
- R3 `tool-catalog` (read, write, edit, glob, grep, bash, webSearch, webFetch)
- R8 `permission-engine` — tier-ordered `alwaysDeny > alwaysAsk > alwaysAllow`
- R9 `hooks-engine`, `slash-commands`, `skills-registry` (auto-discovered
  from `.crewhaus/`)
- R13 `sub-agent-spawner` — `code-explorer` and `test-runner` dispatched
  via the `Task` tool with scoped permissions
- R17 `compaction-autocompact` — Haiku summarises older turns to keep the
  window cheap

## What makes it feel pro-grade (Claude-Code-style)

- **Sub-agent parallelism** — exploration runs in a sandboxed read-only
  agent rather than blocking the main turn. Verification runs in a
  bash-allow-listed agent that can ONLY invoke the project's test command.
- **Project memory bootstrap** — `/init` writes a `CODE-COMPANION.md` at
  the repo root the same way `claude /init` writes `CLAUDE.md`. The
  runtime auto-loads it at every future session start (M3.1).
- **Defense-in-depth permissions** — common dev commands flow without
  prompts (`git status`, `bun test`, `cargo build`), arbitrary shell
  asks once per pattern, destructive patterns (`rm -rf`, `git push -f`,
  `sudo`) are denied even if the model is jailbroken.
- **Skills + slash commands** — drop a `.md` file into
  `.crewhaus/commands/` or a `SKILL.md` into
  `.crewhaus/skills/<name>/` and it appears at startup. No recompile
  needed.

## Fork and extend

Three high-leverage extensions:

1. **Add an MCP server** — uncomment the `mcp_servers:` block at the end
   of [`crewhaus.yaml`](crewhaus.yaml) to wire in GitHub, Postgres,
   filesystem, or any of the
   [reference MCP servers](https://github.com/modelcontextprotocol/servers).
   New tools appear as `<server>__<tool>` automatically.
2. **Add a skill** — create
   `.crewhaus/skills/code-review/SKILL.md` and the model can self-load
   it when relevant. The shipped skills are starter templates.
3. **Optimize the prompt** — once you have inputs + expected outputs in
   a `dataset.jsonl`, run
   `bunx crewhaus optimize crewhaus.yaml --dataset dataset.jsonl
   --graders graders.yaml --write-back` to let the eval-driven optimizer
   mutate the spec for measurable accuracy gains
   ([recipe 42](../recipes/42-active-optimization.md)).

See [`hello-harness-designer`](../hello-harness-designer/) for a
companion harness that DESIGNS new harnesses by interviewing you about
intent.
