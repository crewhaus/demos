# hello-openclaw — a multi-channel always-on personal assistant in one YAML

A local-first, always-on AI assistant in the spirit of
[OpenClaw](https://docs.openclaw.ai) — compiled from a single
[`crewhaus.yaml`](crewhaus.yaml). One daemon listens on Slack,
Telegram, AND Discord simultaneously; the user reaches you through
whatever surface is convenient at the moment.

🦞 EXFOLIATE! EXFOLIATE!

## Run it

From the repo root:

```bash
bun install
bun run compile:hello-openclaw                    # writes dist/{daemon,gateway,session-router,agent}.ts

# Minimum: one channel's creds. Provide all three to listen on all.
ANTHROPIC_API_KEY=sk-ant-... \
  SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... \
  TELEGRAM_BOT_TOKEN=... TELEGRAM_SECRET_TOKEN=... \
  DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_PUBLIC_KEY=... \
  bun run run:hello-openclaw
```

The daemon listens on `PORT` (default `3000`). Point each platform's
webhook there (Slack Event Subscriptions, Telegram setWebhook, Discord
Interactions endpoint). Use ngrok or similar for local dev.

## Try this

From any connected chat:

```
@openclaw what's the weather in Tokyo right now?
```
A `lookup` intent → WebSearch + cite.

```
@openclaw summarise this article: https://en.wikipedia.org/wiki/Lobster
```
A `task` intent → dispatches the `planner` sub-agent, then executes.

```
@openclaw what's a good 4-step lifting workout?
```
A `chat` intent → answers directly, no tool theater.

Try the same prompts via Slack AND Telegram from the same user — each
thread runs in its own isolated session (`routing.sessionKey: thread`),
so the two conversations don't cross-contaminate.

## Swap the model

Like the other heavy-hitter demos, the `model:` field accepts any
provider — edit [`crewhaus.yaml`](crewhaus.yaml) at `agent.model:`:

| Provider | `model:` value | Env var |
|---|---|---|
| Anthropic (default) | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| Anthropic (best) | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| Anthropic (cheap) | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-4o-2024-11-20` | `OPENAI_API_KEY` |
| Google | `gemini-2.0-flash` | `GOOGLE_API_KEY` |
| AWS Bedrock | `bedrock/anthropic.claude-sonnet-4-20250514-v1:0` | `AWS_*` |

## How it relates to OpenClaw

OpenClaw is a multi-channel always-on assistant with a JSON config,
plugin SDK, ClawHub registry, and 20+ channel adapters. This demo
replicates the **single most distinctive surface feature** — one
daemon listening on multiple channels with per-thread session
isolation — in ~130 lines of YAML, using existing CrewHaus
infrastructure.

### What's covered out of the box

| OpenClaw feature | CrewHaus mechanism |
|---|---|
| Multi-channel daemon | `channels: { slack, telegram, discord }` |
| Warm/brief tone | `agent.instructions:` |
| Approval workflows | `permissions: alwaysAsk` (n/a here — channel daemon converts `ask` → `deny`, so destructive tools are blocked outright) |
| Multi-provider model swap | `model:` prefix |
| MCP connectors | `mcp_servers:` block (uncomment to enable) |
| Per-thread sessions | `routing.sessionKey: thread` |
| Tool planner | `sub_agents.planner` (called via `Task` tool) |
| Compaction (memory window) | `compaction: { model: claude-haiku-* }` |
| Skills / slash commands | `.crewhaus/skills/`, `.crewhaus/commands/` (auto-discovered) |

### What's deferred (factory changes needed)

These OpenClaw features require new spec fields + runtime support and
are tracked in the plan at
[`/Users/bots/.claude/plans/add-a-couple-heavy-cozy-popcorn.md`](../../) under "Phase 3":

| OpenClaw feature | Status | Tracked as |
|---|---|---|
| Heartbeat / scheduled wake (`every: 2h`) | Deferred | Phase 3 §3.1 (~2-3 days) |
| Per-channel emoji status reactions (👀 / ✅ / ⚠️) | Deferred | Phase 3 §3.2 (~1 day per channel) |
| CLI banner with tagline rotation | Deferred | Phase 3 §3.3 (~1 day) |
| Gateway / control-UI web dashboard | Deferred | Phase 3 §3.4 (~1-3 days; reuses existing `gateway-server` package) |
| Additional channel adapters (Matrix, Signal, IRC, Nostr, WeChat, …) | Out of scope | each ~1 week |

When those land, the corresponding YAML blocks (commented out at the
top of [`crewhaus.yaml`](crewhaus.yaml)) get enabled.

## What this slice exercises

Catalog modules touched (per factory's
[docs/MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):

- F1 `spec-schema`, `spec-parser`, `spec-validator`, `ir-model` —
  channel target with `IrSecretRef` env interpolation
- F2 `compiler-core`, `target-channel-bot` (multi-file codegen),
  `codegen-templates`
- R1 `runtime-orchestrator` — `runChatLoop({ singleTurn: true, resume })`
- R4 `tool-fs` (`Read`), `tool-web` (`WebSearch`, `WebFetch`),
  `tool-task` (sub-agent dispatch)
- R7 `session-store`, `event-log` — per-thread session resumption
- R8 `permission-engine` — `ask`-mode rules convert to `deny` for
  this non-interactive shape; destructive patterns explicitly denied
- R9 `hooks-engine`, `slash-commands`, `skills-registry` — all
  auto-discovered from `.crewhaus/`
- R13 `channel-adapter-base`, `channel-adapter-slack`,
  `channel-adapter-telegram`, `channel-adapter-discord` — webhook
  verify, event parse, threaded reply
- R13 `sub-agent-spawner` — `planner` sub-agent with scoped read-only
  permissions
- R17 `compaction-autocompact` — Haiku summarises older turns per
  session to keep the context window cheap

## What makes it feel like OpenClaw

- **Always-on daemon** — once you `bun run run:hello-openclaw`, the
  process listens forever. No "open a terminal" / "start a chat"
  ceremony.
- **Multi-channel presence** — same agent answers on whichever surface
  the user pings. Slack at work, Telegram on the train, Discord with
  friends.
- **Per-thread session isolation** — each thread runs an independent
  agent session, so conversations don't bleed. Implemented by
  `routing.sessionKey: thread` — one line of YAML.
- **Warm, brief tone** — the instructions block bakes in OpenClaw's
  "competent teammate" register. No fluff, no preambles.
- **Tool planner pattern** — multi-step tasks dispatch the `planner`
  sub-agent first, then execute. Mirrors OpenClaw's plan-then-act
  philosophy.
- **🦞 branding** — the agent identifies as 🦞 in its first reply on
  any thread. (CLI banner + tagline rotation lands in Phase 3 §3.3.)

## Fork and extend

1. **Add MCP connectors** — uncomment any block under `mcp_servers:`
   in [`crewhaus.yaml`](crewhaus.yaml) to wire in your calendar
   (Google Calendar MCP), todo list (Things MCP), email (Gmail MCP),
   or any of the [reference MCP servers](https://github.com/modelcontextprotocol/servers).
2. **Add more channels** — `channels:` already supports `whatsapp:`
   and `imessage:` blocks (see
   [hello-channel-whatsapp](../hello-channel-whatsapp/) and
   [hello-channel-imessage](../hello-channel-imessage/) for the
   credential shape).
3. **Add custom skills** — drop a `SKILL.md` into
   `.crewhaus/skills/<name>/` and the model can self-load it when
   relevant. The shipped skills are starter templates.
4. **Optimize the prompt against your real channel traffic** —
   collect a `dataset.jsonl` of (inbound, expected-reply) pairs and
   run
   `bunx crewhaus optimize crewhaus.yaml --dataset dataset.jsonl
   --graders graders.yaml --write-back` to let the eval-driven
   optimizer mutate the instructions for measurable accuracy gains.

See [`hello-code`](../hello-code/) and [`hello-chat`](../hello-chat/)
for the sibling heavy-hitter demos.
