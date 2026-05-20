---
test:
  spec: hello-multichat/crewhaus.yaml
  bun_scripts:
    - compile:hello-multichat
---

# Recipe 51 — Multi-channel Personal Assistant (à la OpenClaw)

Build a local-first, always-on, multi-channel personal AI assistant
— the kind of always-on agent OpenClaw popularised — compiled from a
single YAML file. One daemon listens on Slack, Telegram, AND Discord
simultaneously. The same user reaches the agent through whichever chat
surface is convenient at the moment.

🦞 EXFOLIATE! EXFOLIATE!

By the end you'll have a daemon that:

- Listens on three chat platforms in one process.
- Keeps per-thread sessions isolated (`routing.sessionKey: thread`).
- Dispatches a `planner` sub-agent for multi-step tasks before acting.
- Refuses host-shell access from any channel inbound — a random user
  in your Discord cannot run `Bash` on your laptop.
- Auto-loads three skills (`assistant-tone`, `heartbeat-decide`,
  `approval-workflow`) from `.crewhaus/skills/`.

Time: ~10 minutes to run if you already have channel credentials;
~30 minutes to obtain credentials from scratch.

<details>
<summary><strong>Architectural context</strong> — why <code>channel</code> beats <code>cli</code> for this product</summary>

OpenClaw's distinctive surface feature is that the user's chat app is
the user interface; the CLI is the operator interface. That's a
**`target: channel`** shape, not a **`target: cli`** shape — the
runtime spawns a long-running HTTP listener per channel, threads
inbound webhooks through `runChatLoop({ singleTurn: true, resume })`,
and replies in-thread.

The CrewHaus channel schema already supports **multiple channels in
one spec** (see [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts)
`channelsBlock`). That's the half of OpenClaw's value proposition that
comes for free.

The other half — heartbeats, status emoji reactions, the gateway
control UI, additional channel adapters (Matrix, Signal, IRC, Nostr,
WeChat) — is **out of scope for this recipe** and tracked in the
heavy-hitter plan as Phase 3 §3.1–§3.4. The deferred items are
explicit in the spec via commented-out blocks at the top of
[`hello-multichat/crewhaus.yaml`](../hello-multichat/crewhaus.yaml).

</details>

## Prerequisites

- [Bun](https://bun.sh) 1.2 or later.
- An Anthropic credential.
- Worked through [Recipe 03 — Slack Bot](03-slack-bot.md) first.
- **At least one** channel's credentials — see Step 2 below for which.
- A way to expose your local port 3000 to the internet for testing
  (ngrok or similar). Production deploys put the daemon behind a real
  hostname; for development, ngrok is fine.

## Step 1 — Compile, run with one channel

The minimum viable run is with just Slack:

```bash
bun install
bun run compile:hello-multichat
ANTHROPIC_API_KEY=sk-ant-... \
  SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... \
  bun run run:hello-multichat
```

The compiler emits four files into `hello-multichat/dist/`:
`agent.ts` (the chat loop), `session-router.ts` (thread → session
keying), `gateway.ts` (HTTP listener + adapter dispatch), and
`daemon.ts` (the entry point that wires it all together).

The daemon listens on `PORT` (default 3000). Point Slack's
Event Subscriptions URL at `https://<your-ngrok>.ngrok.io/slack/events`.

## Step 2 — Add Telegram and Discord

Set additional env vars; the daemon picks them up:

```bash
SLACK_BOT_TOKEN=xoxb-... SLACK_SIGNING_SECRET=... \
  TELEGRAM_BOT_TOKEN=... TELEGRAM_SECRET_TOKEN=... \
  DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... DISCORD_PUBLIC_KEY=... \
  bun run run:hello-multichat
```

In `hello-multichat/crewhaus.yaml`:

```yaml
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
  telegram:
    botToken: $TELEGRAM_BOT_TOKEN
    secretToken: $TELEGRAM_SECRET_TOKEN
  discord:
    applicationId: $DISCORD_APP_ID
    botToken: $DISCORD_BOT_TOKEN
    publicKeyHex: $DISCORD_PUBLIC_KEY
```

If you only have Slack credentials, comment out the `telegram:` and
`discord:` blocks — the schema requires at least one channel but the
rest are optional.

## Step 3 — Per-thread session isolation

```yaml
routing:
  sessionKey: thread
```

Every thread on every channel becomes a separate session under
`~/.crewhaus/sessions/<sessionId>.jsonl`. The same user pinging you in
two different Slack threads gets two independent agents — context
doesn't bleed.

If you wanted global memory across all conversations from a single
user, use `sessionKey: user` instead. The trade-off: the agent remembers
everything that user has ever asked, including in unrelated channels.
Most users want `thread` — see [recipe 03](03-slack-bot.md) for the
trade-off matrix.

## Step 4 — The planner sub-agent

For multi-step tasks ("draft an email", "summarise this article"), the
main agent dispatches a `planner` sub-agent first:

```yaml
sub_agents:
  planner:
    description: |
      Builds a 3-5 step plan with tool selection and risks. ...
    instructions: |
      Given a request, return:
        1. A numbered 3-5 step plan, each step naming the tool ...
        2. 1-2 risks ...
        3. Single recommendation line: "Suggested next: <step 1>".
      ...
      Do NOT execute any tool yourself. Your job is purely to plan;
      the main agent executes.
    tools: [read, webSearch, webFetch]
    permissions:
      allow: [Read, WebSearch, WebFetch]
      deny: []
```

This mirrors OpenClaw's "tool planner" — a deliberate plan-then-act
separation that surfaces multi-step intent before the agent burns
turns executing.

## Step 5 — Permission rules for a public-facing daemon

This is the most important section to understand.

```yaml
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAllow, pattern: WebSearch }
    - { type: alwaysAllow, pattern: WebFetch }
    - { type: alwaysAllow, pattern: Task }

    - { type: alwaysDeny, pattern: Bash(**) }
    - { type: alwaysDeny, pattern: Write(**) }
    - { type: alwaysDeny, pattern: Edit(**) }
```

**Critical invariant**: a `channel` target is non-interactive. The
permission engine converts `alwaysAsk` to `alwaysDeny` because there's
no terminal to prompt at. If you `alwaysAsk` `Bash(**)` here, you've
effectively `alwaysDeny`'d it — but if you forget the explicit deny
and `alwaysAllow` `Bash` for some reason, a random Discord user can
run shell commands on your laptop.

This recipe is the "OpenClaw imitation," not the "OpenClaw security
review" — but the lesson is independently important. **Read [recipe 29
(permissions)](29-permissions-deep-dive.md) and [recipe 41 (security
fabric)](41-security-fabric.md) before deploying any channel daemon
that touches the network.**

## Step 6 — Skills auto-load from `.crewhaus/`

Three skills ship with the demo:

- **`assistant-tone`** (loads on every reply) — defines 🦞's voice:
  warm/brief/verb-first; words to avoid; channel-aware formatting.
- **`heartbeat-decide`** (forward-compatible with Phase 3 §3.1) —
  defines "when nothing happened, stay silent."
- **`approval-workflow`** — explicit y/n confirmation for any
  side-effecting tool call.

The `approval-workflow` skill is the closest you'll get to OpenClaw's
chat-thread approval prompts until per-tool reactive UI is built into
the channel adapters (Phase 3 §3.2). For now, the agent asks in-text,
and you reply y or n in the same thread.

## Step 7 — Swap the model

Same recipe as 49 and 50. `claude-sonnet-4-6` is a good default — a
multi-channel daemon is verbose enough that Sonnet's price/perf is
better than Opus for the cost.

## What's deferred (and why)

This demo deliberately ships *without* the following OpenClaw
features, all tracked in the heavy-hitter plan's Phase 3:

| Feature | Why deferred |
|---|---|
| Heartbeat (`every: 2h`) | New spec field + IR + runtime tick loop. ~2-3 days of work. See plan §3.1. |
| Status emoji reactions (👀/✅/⚠️) | Each channel adapter needs a `react(messageId, emoji)` API. ~1 day per channel × 5. Plan §3.2. |
| CLI banner with tagline rotation | Spec field + target-cli emitter touch-up. ~1 day. Plan §3.3. |
| Gateway control-UI dashboard | Reuses existing `gateway-server` + `studio-ui` packages — just needs wiring on the channel target. ~1-3 days. Plan §3.4. |
| Additional channel adapters (Matrix, Signal, IRC, Nostr, WeChat, …) | Out of scope; ~1 week per platform. |

When those land, the corresponding YAML blocks (commented out at the
top of [`crewhaus.yaml`](../hello-multichat/crewhaus.yaml)) get
enabled.

## What makes it feel pro-grade (OpenClaw-style)

1. **Always-on daemon** — once you `bun run run:hello-multichat`, the
   process listens forever. No "open a terminal" ceremony.
2. **Multi-channel presence** — same agent answers wherever the user
   pings. Slack at work, Telegram on the train, Discord with friends.
3. **Per-thread session isolation** — each thread is its own session;
   conversations don't bleed.
4. **Warm, brief tone** — the instructions block bakes in OpenClaw's
   "competent teammate" register. No fluff, no preambles.
5. **Plan-then-act** — multi-step tasks dispatch the `planner`
   sub-agent first. Mirrors OpenClaw's tool-planner philosophy.

## Further reading

- [Recipe 03 — Slack Bot](03-slack-bot.md) — the single-channel
  starting point this recipe extends to multi-channel
- [Recipe 28 — Sub-Agents & Task](28-sub-agents-and-task.md)
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) —
  read this before deploying ANY channel daemon
- [Recipe 41 — Security Fabric](41-security-fabric.md) — boundary
  classification at every site that ingests externally-controlled
  content, including channel inbound payloads
- [Recipes 37–40](37-channel-telegram.md) — single-channel adapter
  walkthroughs for Telegram, Discord, WhatsApp, iMessage
- [Recipe 13 — MCP Servers](13-mcp-servers.md) — connect to your
  calendar (Gmail/Calendar MCP), todos (Things MCP), notes (Obsidian
  MCP), etc., to make the agent actually useful on your real life
