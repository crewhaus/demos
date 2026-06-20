---
test:
  spec: starters/channels/discord/crewhaus.yaml
  bun_scripts:
    - smoke:section-33-discord
---

# Recipe 38 — Channel: Discord

The Discord-specific bits of the channel target: Ed25519 signature
verification of the `<timestamp><body>` payload, the four interaction
types Discord delivers (PING, slash command, component click, modal
submit), and thread-vs-channel session keying via `parent_id`.

For the channel-target mental model, read [Recipe 03 — Slack Bot](03-slack-bot.md)
first. This recipe covers only the Discord-specific deltas.

> **Prerequisite — read [Recipe 00 — Network Security
> Primer](00-network-security-primer.md) first.** Every channel
> adapter must classify inbound text after authenticating it, and
> the primer covers the universal `classifyBoundary` pattern this
> recipe assumes. Discord's Ed25519 signature (Step 3 below) proves
> the envelope came from Discord; the primer's `classifyBoundary`
> call protects against prompt injection from authenticated users.

## Prerequisites

- [Recipe 03 — Slack Bot](03-slack-bot.md) for the channel mental model.
- A Discord application from the
  [Developer Portal](https://discord.com/developers/applications)
  with an interactions endpoint.

## Step 1 — Create the application

1. **Developer Portal** → **New Application** → name it.
2. **Bot tab** → reveal **Bot Token**. Save as `DISCORD_BOT_TOKEN`.
3. **General Information** → grab **Application ID** + **Public Key**.
   Save as `DISCORD_APPLICATION_ID` + `DISCORD_PUBLIC_KEY`.
4. **Interactions tab** (you'll set the endpoint URL after the daemon
   is running).

```bash
DISCORD_APPLICATION_ID=...
DISCORD_BOT_TOKEN=...
DISCORD_PUBLIC_KEY=...
```

Three fields, all needed.

## Step 2 — The spec

[`starters/channels/discord/crewhaus.yaml`](../starters/channels/discord/crewhaus.yaml):

```yaml
name: hello-channel-discord
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a Discord bot. When a slash command, button click, or
    modal submit fires, reply concisely (1-2 sentences). You may use
    the Read filesystem tool to ground answers in repo state.
  tools:
    - read
channels:
  discord:
    applicationId: $DISCORD_APPLICATION_ID
    botToken: $DISCORD_BOT_TOKEN
    publicKeyHex: $DISCORD_PUBLIC_KEY
routing:
  sessionKey: thread
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
```

Three Discord-specific fields:

| Field            | Used for                                                |
| ---------------- | ------------------------------------------------------- |
| `applicationId`  | Identifies the app (e.g. registering slash commands).    |
| `botToken`       | REST API calls (posting replies to the channel, typing indicators). |
| `publicKeyHex`   | Ed25519 verification of incoming interactions.           |

## Step 3 — Ed25519 verification

Discord signs every interaction:

```http
POST /discord/events HTTP/1.1
X-Signature-Ed25519: <hex signature>
X-Signature-Timestamp: <unix timestamp>

{ "type": 2, "data": { "name": "summarize", ... }, ... }
```

The signature is over `timestamp + body` concatenated, signed with
the application's private key. The runtime verifies via `crypto.verify`
(Node's built-in) against the public key — no SDK dependency.

If verification fails, the daemon returns `401 Unauthorized` without
touching `runChatLoop`. Discord retries delivery briefly, then gives
up.

The smoke harness uses `generateEd25519Keypair()` +
`signDiscordBody()` to produce valid test payloads — see
[`packages/channel-adapter-discord/src`](https://github.com/crewhaus/factory/blob/main/packages/channel-adapter-discord)
for the helpers.

## Step 4 — Compile and register

```bash
bun run compile starters/channels/discord
bun starters/channels/discord/dist/daemon.ts
```

Point ngrok at the daemon's port:

```bash
ngrok http 3000
```

In the Developer Portal → **Interactions tab** → paste your tunnel's
URL with the `/discord/events` suffix:

```
https://<your-tunnel>/discord/events
```

Discord immediately sends a `PING` (interaction type 1). The adapter
responds `{ type: 1 }` (PONG). On a successful PING, the portal
saves the URL.

## The four interaction types

| Type | Name           | What it is                                                  |
| ---- | -------------- | ----------------------------------------------------------- |
| 1    | PING           | Discord's "are you alive?" check. Adapter replies PONG.      |
| 2    | Application command | Slash command, e.g. `/summarize url:https://...`.        |
| 3    | Message component | Button click, select-menu choice, etc.                     |
| 5    | Modal submit    | User submitted a modal form.                                |

The adapter renders each type into a **user message** the model sees:

| Type | Rendered as                                                  |
| ---- | ------------------------------------------------------------ |
| 2    | `/summarize url=https://...` (just like CLI invocation).      |
| 3    | `[component:<custom_id>]` (lets the model decide based on id). |
| 5    | `<custom_id>: field1=value1 field2=value2` (form contents).   |

So the agent's prompt can just say "when the user runs /summarize,
fetch the URL and summarize it" — the rendering makes slash commands
look like normal text input.

## Session keying

`routing.sessionKey: thread`:

| Channel structure              | Session key                                  |
| ------------------------------ | -------------------------------------------- |
| Top-level guild channel         | `channelId`.                                  |
| Thread (`channel.parent_id` set)| `parentId:channelId` — thread-scoped.        |
| DM                              | `channelId` (= the DM's id).                 |

So a discussion in a guild thread gets its own session, separate
from the parent channel.

## Sending replies

Once `runChatLoop` finishes, the daemon posts the reply straight to
the interaction's channel with the bot token:

```
POST https://discord.com/api/v10/channels/<channelId>/messages
Authorization: Bot <DISCORD_BOT_TOKEN>

{ "content": "Your reply" }
```

This is `sendReply` in the adapter. It's the same channel-post call
the proactive `SendMessage` tool uses (see below) — the bot token
authorizes it, and if the bot is in the channel the message lands.

There's no deferred-interaction dance and no interaction-token
follow-up: the v0 channel daemon doesn't carry the interaction token
through to the reply path, so the reply is an ordinary channel
message rather than an interaction response. That means **no
ephemeral replies and no per-user replies** — everyone in the channel
sees the bot's message.

## Posting to a channel proactively

```
POST https://discord.com/api/v10/channels/<channelId>/messages
Authorization: Bot <DISCORD_BOT_TOKEN>
```

Used by the `SendMessage` tool (see [Recipe 03 — Step 6](03-slack-bot.md#step-6--proactive-sends-with-the-sendmessage-tool))
for proactive sends. Discord doesn't gate this beyond bot permissions
— if the bot is in the channel, the message posts.

## Typing indicator

```
POST https://discord.com/api/v10/channels/<channelId>/typing
```

Shows "Bot is typing..." for ~10 seconds. `setTyping` fires this
best-effort before the model runs and swallows any failure so a
flaky typing call never breaks the reply flow. The adapter doesn't
loop the typing call automatically (Discord deprioritizes "Bot is
typing..." visibility).

## Worked examples

### Slash-command-to-agent

Register `/ask` via Discord's REST API:

```bash
curl -X POST "https://discord.com/api/v10/applications/$DISCORD_APPLICATION_ID/commands" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ask",
    "description": "Ask the bot a question",
    "options": [{
      "name": "question",
      "type": 3,
      "description": "What do you want to ask?",
      "required": true
    }]
  }'
```

Then in your spec:

```yaml
agent:
  instructions: |
    On a /ask command, treat the user's `question` argument as their
    prompt and reply in 1-2 sentences.
```

### Modal form for structured input

Discord modals (interaction type 5) let you collect structured input:

```yaml
agent:
  instructions: |
    When the user runs /escalate, show a modal asking for:
      - Severity (P0 / P1 / P2 / P3)
      - Description (paragraph)
      - On-call team (security / platform / app)
    On modal submit, format the fields into a Slack message and post
    via the slack__post_message MCP tool.
```

The adapter renders the modal submit as
`escalate: severity=P0 description=... oncall=security`.

## Side-by-side with Slack / Telegram

The gateway dispatches by URL path prefix:

```
/slack/events    → slack adapter
/telegram/events → telegram adapter
/discord/events  → discord adapter
```

A spec can declare multiple channels in one block:

```yaml
channels:
  slack:    { botToken: $SLACK_BOT_TOKEN, signingSecret: $SLACK_SIGNING_SECRET }
  discord:  { applicationId: $DISCORD_APPLICATION_ID, botToken: $DISCORD_BOT_TOKEN, publicKeyHex: $DISCORD_PUBLIC_KEY }
  telegram: { botToken: $TELEGRAM_BOT_TOKEN, secretToken: $TELEGRAM_SECRET_TOKEN }
```

One daemon, three channels. Each maintains its own session space —
a Slack thread and a Discord thread don't share sessions even if
they're "the same conversation" conceptually.

## Smoke

```bash
bun run smoke:section-33-discord
```

Validates:

1. PING handling (type 1 → PONG).
2. Slash command parsing.
3. Component click parsing.
4. Modal submit parsing.
5. Ed25519 verification (positive + negative).

Uses `generateEd25519Keypair()` to produce valid test payloads.

## What to read next

- **Same shape, different channels.** [Recipe 37 — Telegram](37-channel-telegram.md),
  [Recipe 39 — WhatsApp](39-channel-whatsapp.md),
  [Recipe 40 — iMessage](40-channel-imessage.md).
- **Channel-target mental model.** [Recipe 03 — Slack Bot](03-slack-bot.md).

## Pointers to source

- **Example:** [`starters/channels/discord/crewhaus.yaml`](../starters/channels/discord/crewhaus.yaml).
- **Adapter:** [`packages/channel-adapter-discord`](https://github.com/crewhaus/factory/blob/main/packages/channel-adapter-discord).
- **Spec schema (discord block):** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts).
- **Module catalog reference:** §33 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
