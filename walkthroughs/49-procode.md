---
test:
  spec: starters/showcases/procode/crewhaus.yaml
---

# Recipe 49 — Pro-grade Coder (à la Claude Code)

Build a pro-grade coding companion — the kind of agent Claude Code and
Cursor have set the bar for — from a single YAML file: sub-agents for
scoped codebase exploration, a `test-runner` that detects your test
command, allow-listed bash for common dev loops, hard-denied
destructive patterns, slash commands (`/init`, `/review`, `/test`,
`/plan`), skills (`debug`, `code-review`, `refactor`), and a
project-memory bootstrap.

By the end you'll have an agent that can:

- Explore a codebase via a read-only sub-agent that keeps the file-dump
  noise out of your main context.
- Edit files with permission gating.
- Run your project's tests via a scoped sub-agent that detects the
  test command from `package.json` / `Cargo.toml` / `pyproject.toml`.
- Bootstrap a `CODE-COMPANION.md` project-memory file you can carry
  across sessions.
- Refuse to run `rm -rf`, `git push --force`, or `sudo` even if the
  model is jailbroken.

Time: ~5 minutes to run; ~30 minutes to read through the spec and
understand each decision.

<details>
<summary><strong>Architectural context</strong> — why this is a recipe, not a starter template</summary>

Recipe 01 builds the smallest possible CLI agent — five lines of YAML.
This recipe is the *full power* version of that same `cli` shape: same
runtime, same compiler, same security model — but every primitive
(sub-agents from recipe 28, skills from 15, slash
commands from 16, permission tiers from 29) wired into a single
coherent spec that mirrors a tier-one production harness.

The empirical claim: the gap between "starters/cli" and a Claude-Code-
style pro coding agent is a few hundred lines of YAML, not a separate
runtime.
If your spec is missing something a tier-one harness has, the answer
is almost always "add a permission rule" or "add a sub-agent" or "add
a skill" — not "fork the compiler."

</details>

## Prerequisites

- [Bun](https://bun.sh) 1.2 or later.
- An Anthropic credential (`claude setup-token` or
  [console.anthropic.com](https://console.anthropic.com/settings/keys)).
- Worked through [recipe 01](01-cli-coding-agent.md) — the canonical
  CLI walkthrough.
- Read [recipe 29](29-permissions-deep-dive.md) — every coding agent
  is one bad bash pattern away from a disaster, and you need to know
  how rule order decides the outcome before reading the spec's
  `permissions:` block.

## Step 1 — Run it first, read it second

Standalone (from the harness directory):

```bash
cd starters/showcases/procode
bunx crewhaus compile crewhaus.yaml -o dist
ANTHROPIC_API_KEY=sk-ant-... bunx crewhaus run crewhaus.yaml   # or: bun install --cwd dist && bun dist/agent.ts
```

Or, working inside the demos checkout, from the repo root:

```bash
bun install
bun run compile starters/showcases/procode
ANTHROPIC_API_KEY=sk-ant-... bun run run starters/showcases/procode
```

Drop into a project you care about (`cd ~/my-project` first, or pass
the cwd via `bun /path/to/dist/agent.ts`) and paste:

```
explore this repo and tell me what it does in 5 bullets
```

The first thing you'll see is `Task(code-explorer, …)` — the agent
dispatching a read-only sub-agent that maps the repo in its own context
via glob/grep/read. That's the recipe's flagship move. Because
`code-explorer` is fully read-only, emitting several of them in one turn
runs them concurrently (the runtime caps how many at once, default 4) —
that's how you map several subsystems in parallel. Workers that can run
commands or write (`test-runner`, `reviewer`, …) serialize instead.

## Step 2 — The sub-agents

Open [`starters/showcases/procode/crewhaus.yaml`](../starters/showcases/procode/crewhaus.yaml) and
look at the `agent.sub_agents:` map. It's a fleet (orchestrator,
reviewer, security-auditor, debugger, docs-writer, verifier, …) — here
are the two foundational roles:

```yaml
agent:
  sub_agents:                     # nested under `agent:` — never top-level
    code-explorer:
      description: |
        Read-only codebase mapper. ...
      instructions: |
        You are a read-only codebase explorer. ...
      # Sub-agent tool lists use the REGISTERED (PascalCase) tool names.
      tools: [Read, Glob, Grep]
      permissions:
        allow: [Read, Glob, Grep]
        deny: []
    test-runner:
      description: |
        Runs the project's test command exactly once ...
      tools: [Read, Bash]
      permissions:
        allow:
          - Read
          - Bash(npm test*)
          - Bash(bun test*)
          # ... 8 more test-runner patterns
        deny:
          - Bash(**rm -rf **)
          - Bash(**sudo **)
```

The `description:` field is **required** (Zod-validated) and is what
the main agent reads when deciding which sub-agent to dispatch. Treat
it as the sub-agent's elevator pitch.

The `permissions:` field on a sub-agent is **NOT** the same shape as
the top-level `permissions:` block. Sub-agent permissions are
`{ allow: [], deny: [] }` — no `mode`, no `rules`. That's a footgun
worth knowing; the [recipe 28](28-sub-agents-and-task.md)
walkthrough has the full rationale.

## Step 3 — The permission allow-list

The shape that makes this feel "safe by default while productive":

```yaml
permissions:
  mode: default
  rules:
    # Destructive patterns: denied, and written FIRST.
    - { type: alwaysDeny,  pattern: Bash(rm -rf**) }
    - { type: alwaysDeny,  pattern: Bash(sudo**) }
    - { type: alwaysDeny,  pattern: Bash(git push --force**) }
    - { type: alwaysDeny,  pattern: Bash(git reset --hard**) }

    # Reads: always-on.
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAllow, pattern: Glob }
    - { type: alwaysAllow, pattern: Grep }

    # Common dev bash: always-on without prompts.
    - { type: alwaysAllow, pattern: Bash(npm *) }
    - { type: alwaysAllow, pattern: Bash(bun *) }
    - { type: alwaysAllow, pattern: Bash(cargo *) }
    - { type: alwaysAllow, pattern: Bash(git status*) }
    - { type: alwaysAllow, pattern: Bash(git commit *) }
    # ... 20 more dev patterns

    # Other bash: ask. Last, so it can't shadow anything above.
    - { type: alwaysAsk,   pattern: Bash(**) }
```

Rule order **is** the policy, and it's the thing to get right before
anything else here — see [recipe 29](29-permissions-deep-dive.md). The
engine takes the first rule whose pattern matches, in declaration
order; there is no `alwaysDeny` > `alwaysAsk` > `alwaysAllow` tier that
rescues a deny written underneath a matching allow or ask. Put the
denials at the top and the catch-all `Bash(**)` at the bottom, exactly
as the committed spec does.

## Step 4 — Slash commands and skills

`.crewhaus/commands/<name>.md` files become `/<name>` commands at
runtime, expanded with `$ARGUMENTS` substitution.
`.crewhaus/skills/<name>/SKILL.md` files become self-loadable skills.
Neither is declared in the YAML — both are auto-discovered by the
runtime from CWD at startup.

This demo ships:

- **`/init`** writes a `CODE-COMPANION.md` at the repo root summarizing
  the project. Mirrors Claude Code's `claude /init` workflow.
- **`/review`** runs the `code-review` skill over `git diff HEAD`.
- **`/test`** dispatches the `test-runner` sub-agent.
- **`/plan`** produces a plan without editing anything (read-only).
- **`debug`**, **`code-review`**, **`refactor`** skills load by topic.

Try `/plan migrate this repo from CommonJS to ESM` to see plan-only
mode in action.

## Step 5 — Compaction is non-negotiable for a coding agent

```yaml
compaction:
  model: claude-haiku-4-5-20251001
```

A coding session can easily hit 100k input tokens (file reads, test
output, diff inspection). The runtime auto-compacts at 85% of the
context window — snipping old turns first, then summarizing on
`compaction.model` (a cheap model keeps the running cost down; it falls
back to the primary model when unset) — so long sessions never brick.

## Step 6 — Swap the model

The `model:` field is provider-agnostic. Edit
[`crewhaus.yaml`](../starters/showcases/procode/crewhaus.yaml) at `agent.model:`:

| Provider | `model:` | Env |
|---|---|---|
| Anthropic (default) | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| OpenAI | `openai/gpt-4o` | `OPENAI_API_KEY` |
| Google | `gemini/gemini-2.5-flash` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| Bedrock | `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` | AWS credential chain or `AWS_BEARER_TOKEN_BEDROCK`, plus `AWS_REGION` |
| Local | `local/llama-3.3-70b@http://localhost:8080/v1` | — |

Recompile after every spec edit.

## What makes it feel pro-grade (Claude-Code-style)

1. **Sub-agent fan-out** — exploration in a sandboxed read-only
   agent; verification in a bash-allow-listed agent. The main loop
   stays clean while specialists do focused work, and read-only
   explorers dispatched together run concurrently (bounded, default 4)
   while command/write workers serialize.
2. **Project-memory bootstrap** — `/init` writes a CODE-COMPANION.md
   the same way `claude /init` writes CLAUDE.md, and the runtime
   auto-loads it at every future session start (M3.1).
3. **Defense-in-depth permissions** — common dev commands flow
   without prompts; arbitrary shell asks; destructive patterns are
   denied even if the model is jailbroken.
4. **Skills + slash commands without recompiles** — drop a `.md` in
   `.crewhaus/` and it appears at the next session start.

## Further reading

- [Recipe 28 — Sub-Agents & Task](28-sub-agents-and-task.md) — the
  sub-agent dispatch model
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) —
  declaration order, pattern grammar, mode invariants
- [Recipe 14 — Hooks](14-hooks.md) — pre-tool hooks as an optional
  defense-in-depth layer on top of permissions. This demo doesn't wire
  one in; its defense-in-depth is the permission ruleset (recipe 29).
- [Recipe 15 — Skills](15-skills.md) — skill discovery and the trust
  origin of skill bodies (Pillar 3)
- [Recipe 41 — Security Fabric](41-security-fabric.md) — every boundary
  this demo crosses (sub-agent return, MCP, skill body, channel
  inbound) is classified before the model sees it
- [Recipe 42 — Active Optimization](42-active-optimization.md) — once
  you have a dataset, the `crewhaus optimize` loop will mutate the
  spec for measurable accuracy gains
