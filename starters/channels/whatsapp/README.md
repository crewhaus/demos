# hello-channel-whatsapp — WhatsApp Business channel adapter

Minimal `target: channel` example wired for WhatsApp Business: a long-running
daemon that receives Meta Graph webhook events at `POST /whatsapp/events`, runs
one model turn per inbound customer message, and replies via the WhatsApp
Business send-message endpoint. Sessions keyed by WhatsApp phone number.

## Run it

```bash
cd starters/channels/whatsapp          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check   # --check writes dist/package.json and installs the bundle's @crewhaus deps
WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... WHATSAPP_APP_SECRET=... \
  ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun dist/daemon.ts
```

Those three Meta values are exactly what the spec declares and what the daemon
enforces: drop any one and it prints `[daemon] missing required env vars: …`
and exits 2 before it opens a socket. The app secret is not optional — every
inbound body is HMAC-SHA256-checked against it, and a request that doesn't
match gets a `401 invalid signature`.

## Point Meta at it

The daemon listens on `PORT` (default 3000). Set `<your-public-host>/whatsapp/events`
as the callback URL in Meta's WhatsApp Business app dashboard — that is a
dashboard-only step, and `crewhaus channel provision` says so rather than
pretending (`whatsapp is configured but not supported by this command`, exit 1).

> **Known gap (crewhaus 0.4.0):** the WhatsApp adapter implements no GET
> verification handshake, so Meta's callback-URL verification request is
> signature-checked like any other inbound and answers `401 invalid signature`
> — this daemon cannot complete that handshake as it stands. (The gateway has
> a `challenge` branch waiting for it; the adapter never returns one.)

See [`walkthroughs/39-channel-whatsapp.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/39-channel-whatsapp.md)
for the 24-hour customer-service window, template-message gating, and the
HMAC-SHA256 signature check.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/channels/whatsapp
bun run run starters/channels/whatsapp
```
</details>
