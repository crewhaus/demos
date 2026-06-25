# hello-channel-telegram — Telegram channel adapter

Minimal `target: channel` example wired for Telegram: a long-running daemon
that long-polls the Telegram Bot API for updates, runs one model turn per
inbound message (DM or chat mention), and replies in the same chat. Sessions
keyed by Telegram chat id.

## Run it

```bash
cd starters/channels/telegram          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist
TELEGRAM_BOT_TOKEN=... ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun dist/daemon.ts
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile channels/telegram
bun run run channels/telegram
```

</details>

The daemon long-polls by default. Set `TELEGRAM_WEBHOOK_URL=...` to switch
to webhook mode (requires a public HTTPS endpoint). See
[`walkthroughs/37-channel-telegram.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/37-channel-telegram.md) for the
update-offset bookkeeping and webhook vs. polling trade-off.
