# hello-channel-discord — Discord channel adapter

Minimal `target: channel` example wired for Discord: a long-running daemon
that registers slash commands, listens for interactions (slash commands,
buttons, modals), and replies concisely in-channel. One model turn per
inbound interaction; sessions keyed by Discord channel.

## Run it

```bash
cd starters/channels/discord          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist
DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... \
  ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun dist/daemon.ts
```

The daemon registers commands at startup and opens a Discord Gateway
WebSocket. See [`walkthroughs/38-channel-discord.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/38-channel-discord.md)
for the interaction-token lifecycle, ephemeral-vs-public reply semantics,
and slash-command registration flow.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile channels/discord
bun run run channels/discord
```

</details>
