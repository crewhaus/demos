---
test:
  spec: starters/channel/crewhaus.yaml
  bun_scripts:
    - smoke:section-12
---

# Recipe 03 — Slack Bot

Stand up a long-running daemon that listens for Slack events,
threads sessions per Slack thread, and replies via the streaming chat
loop. The same channel-target codegen produces daemons for Telegram,
Discord, WhatsApp, and iMessage (covered in recipes 37–40); this
recipe walks through Slack in detail because it's the cleanest worked
example of the multi-channel architecture.

By the end of this recipe you'll have:

- A Slack app with the right OAuth scopes + Event Subscriptions URL.
- A spec that declares Slack credentials by `$VAR_NAME` reference (not
  literal secrets).
- A running daemon that handles `app_mention` and `message` events.
- An understanding of HMAC verification, session keying, and the
  optional `SendMessage` tool for proactive bot-initiated posts.

> **Prerequisite — read the network security primer first.** Every
> channel target (Slack, Telegram, Discord, WhatsApp, iMessage) needs
> [Recipe 00 — Network Security Primer](00-network-security-primer.md)
> as background. It covers the universal "authenticate, then classify"
> pattern this recipe assumes — `classifyBoundary` after HMAC verification
> is identical across channels. Step 6 below shows the Slack-specific
> wiring; the primer shows why.

> **When NOT to use this — try a different shape.**
> - **Building a different channel?** The mental model in this recipe
>   transfers, but the auth/event specifics differ.
>   [Recipe 37 (Telegram)](37-channel-telegram.md),
>   [Recipe 38 (Discord)](38-channel-discord.md),
>   [Recipe 39 (WhatsApp)](39-channel-whatsapp.md),
>   [Recipe 40 (iMessage)](40-channel-imessage.md).
> - **Multi-tenant SaaS** with per-tenant budgets, isolation, and
>   audit → [Recipe 11 — Managed
>   Multitenant](11-managed-multitenant.md). Channel target is
>   single-tenant by design.
> - **A fixed-order pipeline** that just happens to post the result to
>   Slack → [Recipe 02 — Sequential
>   Workflow](02-sequential-workflow.md) with a Slack notification
>   step. Don't pay channel-daemon overhead for a cron job.

<details>
<summary><strong>Architectural context</strong> — channel adapters as a trust boundary and a long-running session surface</summary>

The `channel` target is two things at once: a long-running daemon
pattern (similar to OpenAI's background-mode and AWS AgentCore's
long-running session model) and a **trust boundary** under Pillar 3
([CLAUDE.md](https://github.com/crewhaus/factory/blob/main/CLAUDE.md)). Inbound
Slack messages — even from authenticated users in your own workspace
— are externally-controlled content. Every text body that reaches the
model is classified by
[packages/boundary-classifier](https://github.com/crewhaus/factory/blob/main/packages/boundary-classifier)
with `TrustOrigin: "channel"`; an attacker who DMs your bot a prompt
injection is treated the same as a malicious MCP response. The
mTLS/HMAC verification this recipe walks through tells you *who*
sent the message; it does not say anything about *what* the content
contains. Classification happens after authentication, not instead of
it. Before you wire any destructive tool into a channel-target spec,
read [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md):
the default verdict `ask` converts to `deny` in channel mode (no
interactive surface to prompt on), so every dangerous tool needs an
explicit allow rule with a tight pattern.

</details>

## Prerequisites

- A Slack workspace where you can install a custom app.
- A public HTTPS endpoint for development. Use [ngrok](https://ngrok.com)
  or [cloudflared](https://github.com/cloudflare/cloudflared); both
  give you a free tunnel.
- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics that each Slack reply uses.

## Step 1 — Create the Slack app

In the [Slack API console](https://api.slack.com/apps), create a new
app **From scratch**:

1. **OAuth & Permissions** — give the bot the following scopes:
   - `app_mentions:read`
   - `chat:write`
   - `chat:write.public` (optional, lets the bot post to channels it's
     not a member of)
   - `groups:history`, `channels:history`, `im:history` (so it can read
     messages in threads it's been mentioned in)
2. **Event Subscriptions** — enable, point the Request URL at your
   tunnel (we'll start the daemon in a moment), and subscribe to:
   - `app_mention`
   - `message.channels`, `message.groups`, `message.im` (only the ones
     you want)
3. **Install to workspace** — grab the **Bot User OAuth Token**
   (starts with `xoxb-`).
4. From the **Basic Information** page, grab the **Signing Secret**.

Save both into `.env`:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

Bun auto-loads `.env` on every `bun run` invocation; no dotenv loader
needed.

## Step 2 — The spec

The bundled example [`starters/channel/crewhaus.yaml`](../starters/channel/crewhaus.yaml):

```yaml
name: hello-channel
target: channel
agent:
  model: claude-sonnet-4-6
  instructions: |
    You are a Slack bot. When mentioned in a thread, reply concisely
    (1-2 sentences) in the same thread. You may use the Read filesystem
    tool and the Bash shell tool to ground answers in repo state, but
    Bash invocations are gated and ask for approval each time.
  tools:
    - read
    - bash
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAsk
      pattern: Bash(**)
```

Key things to notice:

- **`target: channel`** — the daemon shape. Unlike `cli`, this emits
  multiple files: `daemon.ts` (the HTTP server boot), `gateway.ts`
  (channel-generic webhook dispatch), `session-router.ts` (deterministic
  session id derivation), and `agent.ts` (the per-message agent wrapper).
- **`agent.tools`** lives under `agent:` for channel specs, unlike the
  CLI shape where `tools:` is top-level. This is the one schema
  discrepancy you'll notice between shapes.
- **`channels.slack.botToken: $SLACK_BOT_TOKEN`** — the dollar-prefix
  syntax tells the compiler "don't bake this literal string into the
  bundle; rewrite it as `process.env.SLACK_BOT_TOKEN` and fail loudly
  at startup if it's missing or empty." Your secrets stay in `.env`.
- **`routing.sessionKey: thread`** — every Slack thread gets its own
  conversation. Other options: `user` (one session per Slack user
  across all channels), `channel` (one session per Slack channel —
  rarely what you want).
- **Permissions** — `Read` is allow-listed for fast answers; `Bash`
  asks every time. In a daemon context "ask" means the daemon prints
  the question to its own stdout/logs; in plain Slack you'd typically
  configure `alwaysAllow Bash(safe-prefix *)` rules instead and run
  the daemon non-interactively.

## Step 3 — Compile and run the smoke test

The smoke test exercises the full inbound path with synthetic webhooks
signed with a test secret — no real Slack workspace required. It is an
end-to-end test against the live Anthropic API, so it **does spend API
credits** on the model turn it drives; it needs `ANTHROPIC_AUTH_TOKEN`
or `ANTHROPIC_API_KEY` in `.env`:

```bash
bun run smoke:section-12
```

If all five scenarios print `PASS` you know the gateway, signature
verification, session router, and a real inbound→model→reply round-trip
work in your environment.

## Step 4 — Run against your tunnel

Standalone (from the harness directory):

```bash
cd starters/channel
bunx crewhaus compile crewhaus.yaml -o dist
bun dist/daemon.ts
```

Or, working inside the demos checkout, from the repo root:

```bash
bun run compile starters/channel
bun run run starters/channel
```

The daemon binds to `:3000` by default. Point your ngrok tunnel at
that port and update the Slack app's Event Subscriptions Request URL
to `https://<your-tunnel>/slack/events`.

The first request Slack sends will be a `url_verification` challenge
— the gateway responds automatically, and Slack confirms the URL.
After that, mentions of your bot or messages in subscribed channels
flow into the daemon. A mention round-trip looks like this:

```
[10:32 AM] @you: @hello-channel what's in this directory?
[10:32 AM] hello-channel: README.md, src/, package.json, tsconfig.json
                          — looks like a TypeScript project.
```

End-to-end: Slack signs and POSTs the event, the gateway verifies the
HMAC, the session router derives `sess_<sha256(threadTs)[:16]>`, the
runtime resumes that session and runs one single-turn
`runChatLoop` — which calls `Bash(ls)`, receives the listing as a tool
result, and replies in-thread via `chat.postMessage`. The four files
that implement each step are next.

## Step 5 — What the daemon actually does

Read the generated `starters/channel/dist/` directory. Four
files, ~100 lines each:

| File                  | Role                                                       |
| --------------------- | ---------------------------------------------------------- |
| `daemon.ts`           | `Bun.serve`, signal handling, channel adapter registration |
| `gateway.ts`          | Channel-agnostic webhook dispatch, signature verification, dedup |
| `session-router.ts`   | Deterministic `sess_<16hex>` derivation from routing key   |
| `agent.ts`            | Per-message `runChatLoop({ singleTurn: true, resume })`    |

The flow for one mention:

```
Slack POST /slack/events
    │
    ▼  daemon.ts → gateway.ts
    │
    ▼  channel-adapter-slack.verify(req)
    │     HMAC-SHA256 of "v0:<ts>:<body>" against X-Slack-Signature,
    │     timing-safe compare, ±5min timestamp window
    │
    ▼  channel-adapter-slack.parseInbound(req)
    │     handles url_verification challenge, skips bot self-mentions,
    │     returns {event, idempotencyKey: slack.event_id}
    │
    ▼  gateway dedup cache (event_id seen before? → 200 OK, no-op)
    │
    ▼  session-router.derive(routing.sessionKey="thread")
    │     sess_<sha256(threadTs)[:16]>
    │
    ▼  agent.ts: runChatLoop({ singleTurn: true, resume: { sessionId } })
    │     event-log replays prior turns; runs one model→tools→done turn
    │
    ▼  channel-adapter-slack.sendReply({event, text})
    │     POST chat.postMessage with the assistant's text
    │
    ▼  200 OK to Slack
```

Two things to internalize:

1. **Session-per-thread is automatic.** You don't manage sessions
   yourself — the router derives the id deterministically from
   `routing.sessionKey`. Slack threads → consistent ids → seamless
   resume.
2. **Each Slack message is one `singleTurn` invocation.** The daemon
   isn't a long-lived REPL with one model call open — it spins up,
   handles one inbound, persists, and responds. Memory across replies
   is via the JSONL event log, not in-process state.

## Step 6 — Slack HMAC verification (the Slack-specific half)

The universal "authenticate, then classify" pattern this step is part
of lives in [Recipe 00 — Network Security
Primer](00-network-security-primer.md). Read that first; this step
covers what's specific to Slack (the HMAC math, the signing secret,
the `v0:` prefix) and shows where the generated `agent.ts` wires the
universal classifier in for you.

### The Slack-specific authentication math

Slack signs every request body before delivery. The adapter at
[`packages/channel-adapter-slack`](https://github.com/crewhaus/factory/blob/main/packages/channel-adapter-slack)
computes:

```
HMAC-SHA256(signing_secret, "v0:" + X-Slack-Request-Timestamp + ":" + raw_body)
```

and compares the result to `X-Slack-Signature` using
`crypto.timingSafeEqual`. The 5-minute timestamp window mitigates
replay. Requests that don't match are rejected at the adapter layer
before any downstream code runs. **This proves the message came
through Slack with your signing secret.** It proves nothing about the
contents of the body Slack signed for.

### The classification call (identical to every other channel)

After authentication, classify the body before it reaches the model:

```ts
import { classifyBoundary } from "@crewhaus/boundary-classifier";

// channel-adapter-slack has already returned the verified event.
const inboundText = event.text;

const verdict = await classifyBoundary(inboundText, { origin: "channel" });
if (verdict.action === "redact" && verdict.redacted !== undefined) {
  await sendReply({ event, text: "I can't process that message." });
  return;
}
await runChatLoop({ /* ... */, userMessage: inboundText });
```

This block is byte-identical across Slack, Telegram, Discord, WhatsApp,
and iMessage. The primer explains the verdict semantics, the severity
defaults for `origin: "channel"`, and the trace-bus event the call
emits. If you find yourself thinking "Slack-authenticated users in our
workspace are fine," re-read the primer's "who vs. what" section —
authentication does not defend against prompt injection from accounts
your authentication already accepted.

### The classifier is already wired inline (don't add a hook)

You don't have to wire this yourself — the channel-target codegen
already does it for you. The generated `agent.ts` imports
`classifyInbound` from `@crewhaus/channel-adapter-base` and calls it on
every inbound message **before** it seeds the model turn:

```ts
// generated agent.ts (excerpt)
import { classifyInbound } from "@crewhaus/channel-adapter-base";

async runTurn(args) {
  const runContext = createRunContext({ sessionId: args.sessionId });
  // Pillar 3 channel boundary — classify the inbound at TrustOrigin
  // "channel" BEFORE it seeds a model turn. Malicious inbound is
  // replaced by a redaction notice; pass/warn content is tagged into
  // runContext.dataLineage so the egress fabric sees the channel origin.
  const __inbound = await classifyInbound(args.message, runContext, { origin: "channel" });
  return await runChatLoop({ /* ... */, seedMessages: [{ role: "user", content: __inbound }] });
}
```

`classifyInbound` wraps the same `classifyBoundary(text, { origin:
"channel" })` call shown above, replaces blocked inbound with a
redaction notice before the model sees it, and tags pass/warn content
into `runContext.dataLineage` so the sink-side egress fabric knows the
content came in over a channel. The decision lands in the JSONL event
log the same way permission decisions for tool calls do.

> **Do not add a `pre-model` hook to re-run the classifier.** Because
> `classifyInbound` is already in the generated `agent.ts`, a hook that
> also called `classifyBoundary` on the same text would **classify every
> inbound message twice** — double the latency and double the classifier
> spend, with no added safety. The inline call is the wiring. See
> [Recipe 14 — Hooks](14-hooks.md) for hooks you *do* add yourself
> (policy guards around tool calls, not the channel boundary).

## Step 7 — Proactive sends with the `SendMessage` tool

By default the bot only replies when mentioned. To let the bot
**initiate** posts (e.g. "summarize the day's PRs at 5pm"), opt the
agent into the `sendMessage` tool:

```yaml
agent:
  tools:
    - sendMessage
```

This registers a model-facing `SendMessage(channel, text)` tool. The
tool is permission-gated: it declares `destructive: true`, so in
`default` mode the engine evaluates fail-closed. To grant it
explicitly:

```yaml
permissions:
  rules:
    - type: alwaysAllow
      pattern: SendMessage
```

The routing key format the model sees is
`<adapterId>:<workspaceId>:<channelId>[:<threadTs>]`. The runtime
dispatches the tool call back through the daemon's registered
channel adapter, which posts the message.

A common pattern is to combine `SendMessage` with a scheduled trigger
— either an external cron that hits `POST /agent/trigger` on the
daemon, or a stand-alone `target: batch` worker (Recipe 08) that
shares the same channel adapter configuration.

## Step 8 — Production deployment

For real Slack workspaces you'll want:

- **A reverse proxy** in front of `Bun.serve` (Nginx / Caddy /
  CloudFront / your gateway of choice) so TLS terminates outside the
  bundle.
- **Process supervision** — `systemd`, k8s Deployment + Service, or
  the bundled Helm chart from [Recipe 24 — Docker and Helm](24-docker-and-helm.md).
- **Persistent storage** for `.crewhaus/sessions/` so a restart picks
  up in-flight threads. Volume-mount it.
- **Secrets via Vault / SOPS / etc.** Each `$VAR_NAME` reference in
  the spec lowers to a `process.env.VAR_NAME` read with a startup-time
  null check — your secret manager only needs to put the env var in
  scope.
- **Monitoring** — set `CREWHAUS_TRACE=json` and pipe stderr to your
  log aggregator. For full Prometheus + OTel, see
  [Recipe 17 — Observability](17-observability.md).

## Step 9 — Going to other channels

The channel target shape supports five adapters; switching is one
block in the spec:

| Channel    | Block                                                              | Verification model                                  | Recipe                                     |
| ---------- | ------------------------------------------------------------------ | --------------------------------------------------- | ------------------------------------------ |
| Slack      | `channels.slack: { botToken, signingSecret }`                      | HMAC-SHA256 over `v0:<ts>:<body>`                   | This recipe                                |
| Telegram   | `channels.telegram: { botToken, secretToken }`                     | `X-Telegram-Bot-Api-Secret-Token` header            | [Recipe 37](37-channel-telegram.md)        |
| Discord    | `channels.discord: { applicationId, botToken, publicKeyHex }`      | Ed25519 over `<timestamp><body>`                    | [Recipe 38](38-channel-discord.md)         |
| WhatsApp   | `channels.whatsapp: { phoneNumberId, accessToken, appSecret }`     | HMAC-SHA256 over raw body, `X-Hub-Signature-256`    | [Recipe 39](39-channel-whatsapp.md)        |
| iMessage   | `channels.imessage: { chatDbPath?, cursorPath? }`                  | None (poll-driven, host-bound, macOS only)          | [Recipe 40](40-channel-imessage.md)        |

You can declare multiple channels in one spec — the gateway dispatches
by URL path prefix (`/slack/events`, `/telegram/events`, etc.) and
each adapter runs side by side.

## Common pitfalls

| Symptom                                                            | Fix                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `url_verification` keeps failing                                   | Check the signing secret matches; check that your tunnel forwards POST bodies intact (some proxies eat them). |
| Bot replies to its own messages forever                            | `parseInbound` already skips bot self-mentions via the `bot_id` field; if you see a loop, you've likely customized the parse path. |
| Same message handled twice                                         | The gateway dedups by `event_id`. Slack retries aggressively if your endpoint times out — make sure the daemon responds within 3 seconds. |
| Replies post to the wrong thread                                   | Check `routing.sessionKey`. With `thread`, replies go to the parent thread. With `user`, replies post as DMs. |
| `process.env.SLACK_BOT_TOKEN is not set` at startup                | The `$VAR_NAME` lowering generates a fail-loud check. Either fix `.env` or set the env var directly before `bun run`. |

## What to read next

- **Same daemon shape, different message source.** [Recipe 37 — Telegram](37-channel-telegram.md), [Recipe 38 — Discord](38-channel-discord.md), [Recipe 39 — WhatsApp](39-channel-whatsapp.md), [Recipe 40 — iMessage](40-channel-imessage.md).
- **Bot does several jobs.** [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md) — route Slack mentions to a researcher + writer + critic crew instead of one agent.
- **Deploy it.** [Recipe 24 — Docker and Helm](24-docker-and-helm.md) — channel-target Helm chart with httpGet healthchecks.
- **Audit + budget per Slack workspace.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) — workspace_id as tenant_id.

## Pointers to source

- **Example:** [`starters/channel/crewhaus.yaml`](../starters/channel/crewhaus.yaml).
- **Channel-target codegen:** [`packages/target-channel-bot`](https://github.com/crewhaus/factory/blob/main/packages/target-channel-bot).
- **Slack adapter:** [`packages/channel-adapter-slack`](https://github.com/crewhaus/factory/blob/main/packages/channel-adapter-slack).
- **Spec schema (channel variant):** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts) (search for `channelSchema`).
- **Module catalog reference:** §12 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
