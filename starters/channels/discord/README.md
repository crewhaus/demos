# hello-channel-discord — Discord channel adapter

Minimal `target: channel` example wired for Discord: a long-running daemon
that serves Discord's interactions endpoint at `POST /discord/events`, runs
one model turn per inbound interaction — a slash command, a button click, or
a modal submit — and replies concisely in-channel.

## Run it

```bash
cd starters/channels/discord          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check   # --check writes dist/package.json and installs the bundle's @crewhaus deps
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_PUBLIC_KEY=... \
  ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun dist/daemon.ts
```

All three Discord values are required — the spec declares them and the daemon
enforces them: drop any one and it prints `[daemon] missing required env
vars: …` and exits 2 before it opens a socket. It then listens on `PORT`
(default 3000). The public key is not optional either: every inbound
interaction is Ed25519-checked against it, and one that doesn't verify gets a
`401 invalid signature`.

## Point Discord at it

This adapter is HTTP-interactions-only. The daemon opens no Discord Gateway
WebSocket and registers no commands at startup — it serves signed POSTs and
nothing else. Discord delivers those to a public HTTPS URL, so the daemon
needs one (a tunnel like `ngrok http 3000` while developing):

```bash
crewhaus channel provision crewhaus.yaml --platform discord \
  --base-url https://your-public-host        # --dry-run prints the calls instead of sending them
```

That PATCHes your app's `interactions_endpoint_url` to
`<base-url>/discord/events` and prints the bot invite URL with the permission
bits it derived. Registering the slash commands stays yours: the adapter
routes *any* command to the agent (rendered as `/<name> <options>`) and the
spec declares no command list, so provision prints the
`PUT /applications/<application-id>/commands` call instead of inventing names.

## Sessions

`routing.sessionKey: thread` — the same strategy the Slack starter uses, but
Discord's interaction payload only carries a thread id inside a real thread
channel (`channel.parent_id` set). There, every interaction in that thread
resumes the same session. In a plain guild channel or a DM there is no thread
id, so the routing key falls back to the interaction id, which is unique per
invocation: **each slash command outside a thread opens a fresh session.**
Use `sessionKey: channel` if you want one continuous session per channel.

See [`walkthroughs/38-channel-discord.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/38-channel-discord.md)
for how each interaction type is rendered into a prompt, why replies are
ordinary public channel messages (no ephemeral replies, no interaction-token
follow-up), and a worked slash-command registration.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/channels/discord
bun run run starters/channels/discord
```

</details>
