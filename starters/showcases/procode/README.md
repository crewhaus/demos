# hello-procode — a pro-grade terminal coding companion in one YAML

A full coding agent — codebase exploration, file editing, test
execution, **multi-agent workflows**, an **exhaustive ULTRACODE mode**,
and an **autonomous goal loop** — compiled from a single
[`crewhaus.yaml`](crewhaus.yaml). It feels tier-one (think Claude Code /
Cursor) on the surface and runs against **any model** (Claude, GPT-4o,
Gemini, Bedrock, local) — see [Swap the model](#swap-the-model) below.

## What's new — workflows, ULTRACODE, and goal loop

Three Claude-Code-class capabilities, all expressed in the same spec:

- **Multi-agent workflows** — `/workflow <goal>` dispatches an
  `orchestrator` that DECOMPOSES the goal, FANS OUT a fleet of specialist
  sub-agents in parallel (`reviewer`, `security-auditor`, `debugger`,
  `docs-writer`, `verifier`, plus the original `code-explorer` /
  `test-runner`), CROSS-CHECKS their returns, and SYNTHESIZES one ranked
  answer. Read-only workers run on a cheaper model by design.
- **ULTRACODE mode** — `/ultracode` flips the agent to exhaustive-by-
  default: every substantive task becomes a verified workflow without you
  asking. Audits, migrations, and security reviews always fan out.
  `/standard` flips it back. For the deepest REASONING budget, pair it
  with `crewhaus run --effort xhigh` (the runtime effort lever — it is
  not a spec field).
- **Goal loop** — `/loop <condition>` records a verifiable completion
  condition to `GOAL.md` and works toward it across turns, judged each
  turn by an INDEPENDENT `verifier` sub-agent (it cannot rubber-stamp its
  own work). `/resume-goal` picks the loop back up in a new session;
  `/verify` runs the independent pass on demand. Because `GOAL.md` lives
  on disk, the goal outlives the conversation context.

## Run it

```bash
cd starters/showcases/procode      # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist               # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-ant-... bunx crewhaus run crewhaus.yaml  # opens REPL in cwd
```

Or, to point it at a specific project, `cd` there first and run the
compiled bundle directly:

```bash
cd ~/my-project
ANTHROPIC_API_KEY=sk-ant-... bun /path/to/demos/starters/showcases/procode/dist/agent.ts
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile showcases/procode
bun run run showcases/procode
```
</details>

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

```
/ultracode then audit this repo for security issues
```
Exhaustive mode — fans out `security-auditor` + `reviewer` in parallel
and merges severity-tagged findings.

```
/workflow find every place we talk to an external API and assess the risk
```
One-off multi-agent fan-out, synthesized into one ranked report.

```
/loop all tests pass and `npm run typecheck` is clean
```
Goal mode — iterates until an independent `verifier` confirms the
condition holds.

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

Recompile (`bunx crewhaus compile crewhaus.yaml -o dist`) after any change to the spec.

Sub-agent `model:` fields are independent of the main agent's — point the
read-only workers at any provider string (the fleet here runs them on
`claude-haiku-4-5-20251001` while the main agent and `orchestrator` stay
on the primary model).

## What this slice exercises

Catalog modules touched (per factory's
[docs/MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):

- F1 `spec-schema`, `spec-parser`, `spec-validator`, `ir-model`
- F2 `compiler-core`, `target-cli-bundle`, `codegen-templates`
- R1 `runtime-orchestrator` (streaming chat loop, session persistence)
- R2 `model-adapter` (provider-agnostic), `prompt-cache-manager`
- R3 `tool-catalog` (read, write, edit, glob, grep, bash, webSearch,
  webFetch, todoWrite, codegraph*) — `todoWrite` drives the visible
  plan/progress list; the `codegraph*` tools do AST symbol lookup and
  blast-radius/impact analysis before a refactor
- R8 `permission-engine` — tier-ordered `alwaysDeny > alwaysAsk > alwaysAllow`
- R9 `hooks-engine`, `slash-commands`, `skills-registry` (auto-discovered
  from `.crewhaus/`), plus `cli.banner` — a cold-start banner with
  rotating taglines (suppressed on resume)
- R13 `sub-agent-spawner` — an 8-agent fleet (`code-explorer`,
  `test-runner`, `orchestrator`, `reviewer`, `security-auditor`,
  `debugger`, `docs-writer`, `verifier`) dispatched via the `Task` tool
  with per-agent models and scoped permissions; parallel fan-out is
  driven by the runtime's concurrent `Task` batching
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
- **Workflows over single shots** — large or high-stakes tasks fan out
  to a fleet of scoped sub-agents and synthesize, the way `claude`
  workflows do, instead of grinding through one conversation.
- **Independent verification** — ULTRACODE and goal mode route the final
  "is it done?" judgment through a separate `verifier` agent, so the
  worker never grades its own paper (the same reason Claude Code's goal
  loop uses an independent evaluator).
- **Durable goals** — `/loop` writes the completion condition to
  `GOAL.md` on disk; the file outlives the conversation context, and
  `/resume-goal` re-reads it to continue in a fresh session.

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
   ([walkthrough 42](https://github.com/crewhaus/demos/blob/main/walkthroughs/42-active-optimization.md)).

See [`harness-designer`](https://github.com/crewhaus/demos/blob/main/starters/harness-designer/) for a companion
harness that DESIGNS new harnesses by interviewing you about intent.
