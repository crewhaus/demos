# hello-channel-telegram — Telegram channel adapter

Minimal `target: channel` example wired for Telegram: a long-running daemon
that long-polls the Telegram Bot API for updates, runs one model turn per
inbound message (DM or chat mention), and replies in the same chat. Sessions
keyed by Telegram chat id.

## Run it

From the repo root:

```bash
bun install
bun run compile channels/telegram
TELEGRAM_BOT_TOKEN=... ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun run run channels/telegram
```

The daemon long-polls by default. Set `TELEGRAM_WEBHOOK_URL=...` to switch
to webhook mode (requires a public HTTPS endpoint). See
[`walkthroughs/37-channel-telegram.md`](../../../walkthroughs/37-channel-telegram.md) for the
update-offset bookkeeping and webhook vs. polling trade-off.
