# hello-channel-telegram — Telegram channel adapter

Minimal `target: channel` example wired for Telegram: a long-running daemon
that serves Telegram's webhook at `POST /telegram/events`, runs one model turn
per inbound update — a message, an edit, or an inline-button press — and
replies in the same chat. Sessions keyed by Telegram chat id (and, in a
supergroup forum, by topic).

## Run it

```bash
cd starters/channels/telegram          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check   # --check writes dist/package.json and installs the bundle's @crewhaus deps
TELEGRAM_BOT_TOKEN=... TELEGRAM_SECRET_TOKEN=... ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun dist/daemon.ts
```

Both Telegram values are required — the spec declares them and the daemon
enforces them: drop either one and it prints `[daemon] missing required env
vars: …` and exits 2 before it opens a socket. It then listens on `PORT`
(default 3000).

## Point Telegram at it

Telegram delivers only to a public HTTPS URL, so the daemon needs one — a
tunnel (`ngrok http 3000`) while developing. Register it:

```bash
crewhaus channel provision crewhaus.yaml --platform telegram \
  --base-url https://your-public-host        # --dry-run prints the call instead of sending it
```

That is a `setWebhook` call: it points the bot at
`<base-url>/telegram/events` and installs `TELEGRAM_SECRET_TOKEN` as the
`X-Telegram-Bot-Api-Secret-Token` header the runtime requires on every inbound
request. Webhook is the only inbound path this bundle emits — there is no
long-polling mode. See
[`walkthroughs/37-channel-telegram.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/37-channel-telegram.md)
for the secret-token handshake, the `allowed_updates` filter, `update_id`
dedup, and how `sessionKey: thread` keys supergroup topics.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/channels/telegram
bun run run starters/channels/telegram
```

</details>
