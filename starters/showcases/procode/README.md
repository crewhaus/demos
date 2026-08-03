# hello-procode — a pro-grade terminal coding companion in one YAML

A full coding agent — codebase exploration, file editing, test
execution, **multi-agent workflows**, an **exhaustive ULTRACODE mode**,
an **autonomous goal loop**, and **persistent cross-session memory** —
compiled from a single [`crewhaus.yaml`](crewhaus.yaml). It feels
tier-one (think Claude Code / Cursor) on the surface and runs against
**any model** (Claude, GPT-4o, Gemini, Bedrock, local) — see
[Swap the model](#swap-the-model) below.

## What's inside — workflows, ULTRACODE, goal loop, memory

Claude-Code-class capabilities, all expressed in the same spec:

- **Multi-agent workflows** — `/workflow <goal>` dispatches an
  `orchestrator` that DECOMPOSES the goal, FANS OUT a fleet of specialist
  sub-agents (`reviewer`, `security-auditor`, `debugger`, `docs-writer`,
  `verifier`, plus the original `code-explorer` / `test-runner`),
  CROSS-CHECKS their returns, and SYNTHESIZES one ranked answer. Emitted
  as ONE batched turn, every worker's result comes back together;
  **read-only workers** (`code-explorer`, and the drop-in `perf-reviewer`)
  run **concurrently** — bounded to a few at once — while workers that can
  run commands or write files serialize (a tool that can execute or mutate
  isn't safe to parallelize). Read-only workers also run on a cheaper
  model by design.
- **ULTRACODE mode** — `/ultracode` flips the agent to exhaustive-by-
  default: every substantive task becomes a verified workflow without you
  asking. Audits, migrations, and security reviews always fan out.
  `/standard` flips it back. Depth comes from orchestration plus a raised
  per-turn output budget (`agent.max_tokens: 16384`; the runtime default
  is 8192).
- **Goal loop** — `/loop <condition>` records a verifiable completion
  condition to `GOAL.md` and works toward it across turns, judged each
  turn by an INDEPENDENT `verifier` sub-agent (it cannot rubber-stamp its
  own work). `/resume-goal` picks the loop back up in a new session;
  `/verify` runs the independent pass on demand. Because `GOAL.md` lives
  on disk, the goal outlives the conversation context — and
  `crewhaus run crewhaus.yaml --continue` reopens the conversation
  itself. `model_fallbacks` keeps long runs alive through provider
  hiccups.
- **Persistent memory** — the `memory:` block wires `Remember`/`Recall`
  tools, auto-captures durable facts at session teardown, and auto-recalls
  the top matches into every future session
  (`.crewhaus/memories/hello-procode.jsonl`). `/init` additionally writes
  a `CODE-COMPANION.md` the runtime auto-loads at session start.
- **Self-improvement loop** — the `feedback:` block adds a one-keystroke
  exit rating to `crewhaus run` and auto-distills accumulated ratings into
  a `hello-procode-ratings` dataset that
  `crewhaus optimize --dataset registry:hello-procode-ratings` can learn
  from. Your thumbs-up/down literally becomes training signal.

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

Useful `crewhaus run` companions: `--continue` (resume the most recent
session for this spec), `--resume <sessionId>` (resume a specific one),
and `--permission-mode plan|auto|bypass` (`plan` = read-only
investigation, `auto` = reads flow / destructive still asks, `bypass` =
flag-only, never expressible in the spec).

The agent's CWD is the project under analysis. `.crewhaus/commands/`,
`.crewhaus/skills/`, and `.crewhaus/sub-agents/` ship inside this demo —
drop your own `.md` files there to add slash commands, skills, and
fleet workers without touching the spec or recompiling.

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
Exhaustive mode — fans out `security-auditor` + `reviewer` in one batched
turn and merges severity-tagged findings.

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
| Anthropic (default) | `claude-opus-5` | `ANTHROPIC_API_KEY` |
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
- R1 `runtime-orchestrator` (streaming chat loop, session persistence +
  `--continue`/`--resume` session resume)
- R2 `model-adapter` (provider-agnostic), `prompt-cache-manager`, plus
  `model_fallbacks` + circuit breaker (provider failover for long runs)
- R3 `tool-catalog` (read, write, edit, glob, grep, bash, bashOutput,
  killShell, webSearch, webFetch, readImage, todoWrite, codegraph*) —
  `todoWrite` drives the visible plan/progress list; `readImage` lets
  the model SEE screenshots and design mocks; `bash(background: true)` +
  `bashOutput` + `killShell` run and poll long-lived processes (dev
  servers, watchers); the `codegraph*` tools do AST symbol lookup and
  blast-radius/impact analysis before a refactor
- R8 `permission-engine` — tier-ordered `alwaysDeny > alwaysAsk >
  alwaysAllow`, plus runtime `--permission-mode plan|auto|bypass`
- R9 `hooks-engine` (the committed
  [`.crewhaus/settings.json`](.crewhaus/settings.json) ships a `pre-tool`
  hook that blocks destructive Bash even if a rule slips),
  `slash-commands`, `skills-registry` (auto-discovered from
  `.crewhaus/`), plus `cli.banner` — a cold-start banner with rotating
  taglines, printed once at bundle boot
- R13 `sub-agent-spawner` — an 8-agent inline fleet (`code-explorer`,
  `test-runner`, `orchestrator`, `reviewer`, `security-auditor`,
  `debugger`, `docs-writer`, `verifier`) plus a drop-in disk worker
  ([`.crewhaus/sub-agents/perf-reviewer.md`](.crewhaus/sub-agents/perf-reviewer.md)),
  dispatched via the `Task` tool with per-agent models and scoped
  permissions; a fan-out is ONE batched turn returning all results
  together, with read-only workers (`code-explorer`, `perf-reviewer`)
  run concurrently (bounded, default 4) and command/write workers
  serialized
- R17 `compaction-autocompact` — automatic at 85% of the context window
  (snip old turns first, then summarize on `compaction.model`, a cheap
  model, falling back to the primary if unset)
- `memory:` block — `Remember`/`Recall` tools + auto-capture at teardown
  + auto-recall at session start; `/init`'s `CODE-COMPANION.md` rides the
  project-memory auto-load (M3.1)
- `feedback:` block — exit ratings → `autoDistill` →
  `hello-procode-ratings` registry dataset → `optimize --ratings`

## What makes it feel pro-grade (Claude-Code-style)

- **Sub-agent fan-out** — exploration runs in a scoped read-only agent
  with its own context window rather than polluting the main one.
  Verification runs in a bash-allow-listed agent that can ONLY invoke
  the project's test command. Dispatch several read-only explorers in
  one turn and they run concurrently (bounded, default 4); workers that
  can run commands or write serialize.
- **Two layers of memory** — `/init` writes a `CODE-COMPANION.md` at
  the repo root the same way `claude /init` writes `CLAUDE.md` (the
  runtime auto-loads it every session, M3.1), and the `memory:` block
  gives the agent `Remember`/`Recall` plus automatic capture/recall of
  incremental facts across sessions.
- **Defense-in-depth permissions** — common dev commands flow without
  prompts (`git status`, `bun test`, `cargo build`), arbitrary shell
  asks once per pattern, destructive patterns (`rm -rf`, `git push -f`,
  `sudo`) are denied even if the model is jailbroken — and a `pre-tool`
  hook in [`.crewhaus/settings.json`](.crewhaus/settings.json) backstops
  the rules in a separate process the model can't talk its way past.
- **Skills, slash commands, and fleet workers on disk** — drop a `.md`
  file into `.crewhaus/commands/`, a `SKILL.md` into
  `.crewhaus/skills/<name>/`, or a worker into
  `.crewhaus/sub-agents/` and it appears at startup. No recompile
  needed.
- **Workflows over single shots** — large or high-stakes tasks fan out
  to a fleet of scoped sub-agents and synthesize, the way `claude`
  workflows do, instead of grinding through one conversation.
- **Independent verification** — ULTRACODE and goal mode route the final
  "is it done?" judgment through a separate `verifier` agent, so the
  worker never grades its own paper (the same reason Claude Code's goal
  loop uses an independent evaluator).
- **Durable goals + resumable sessions** — `/loop` writes the completion
  condition to `GOAL.md` on disk; the file outlives the conversation
  context, `/resume-goal` re-reads it, and
  `crewhaus run --continue` reopens the conversation itself.
- **Long-running work that survives** — bash calls take an explicit
  `timeout` up to 10 minutes for slow suites; `bash(background: true)`
  detaches dev servers and watchers and returns a `bash_id` you poll
  with `BashOutput` and stop with `KillShell`; `model_fallbacks` rides
  out provider failures; and the optional `budget:` block hard-caps
  unattended spend. For scripting, `crewhaus run --prompt "<task>"`
  runs one turn and prints the reply (no REPL).

## Fork and extend

Three high-leverage extensions:

1. **Add an MCP server** — uncomment the `mcp_servers:` block at the end
   of [`crewhaus.yaml`](crewhaus.yaml) to wire in GitHub, Postgres,
   filesystem, or any of the
   [reference MCP servers](https://github.com/modelcontextprotocol/servers).
   New tools appear as `<server>__<tool>` automatically.
2. **Add a skill or a fleet worker** — create
   `.crewhaus/skills/<name>/SKILL.md` and the model can self-load it when
   relevant, or drop a sub-agent into `.crewhaus/sub-agents/<name>.md`
   (see the shipped `perf-reviewer`) and dispatch it via `Task`. The
   shipped skills and workers are starter templates.
3. **Optimize the prompt** — once you have inputs + expected outputs in
   a `dataset.jsonl`, run
   `bunx crewhaus optimize crewhaus.yaml --dataset dataset.jsonl
   --graders graders.yaml --write-back` to let the eval-driven optimizer
   mutate the spec for measurable accuracy gains
   ([walkthrough 42](https://github.com/crewhaus/demos/blob/main/walkthroughs/42-active-optimization.md)).

See [`harness-designer`](https://github.com/crewhaus/demos/blob/main/starters/harness-designer/) for a companion
harness that DESIGNS new harnesses by interviewing you about intent.
