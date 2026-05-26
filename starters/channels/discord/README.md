# hello-channel-discord — Discord channel adapter

Minimal `target: channel` example wired for Discord: a long-running daemon
that registers slash commands, listens for interactions (slash commands,
buttons, modals), and replies concisely in-channel. One model turn per
inbound interaction; sessions keyed by Discord channel.

## Run it

From the repo root:

```bash
bun install
bun run compile channels/discord
DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... \
  ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun run run channels/discord
```

The daemon registers commands at startup and opens a Discord Gateway
WebSocket. See [`recipes/38-channel-discord.md`](../recipes/38-channel-discord.md)
for the interaction-token lifecycle, ephemeral-vs-public reply semantics,
and slash-command registration flow.
