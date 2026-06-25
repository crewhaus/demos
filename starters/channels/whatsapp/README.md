# hello-channel-whatsapp — WhatsApp Business channel adapter

Minimal `target: channel` example wired for WhatsApp Business: a long-running
daemon that receives Meta Graph webhook events, runs one model turn per
inbound customer message, and replies via the WhatsApp Business send-message
endpoint. Sessions keyed by WhatsApp phone number.

## Run it

```bash
cd starters/channels/whatsapp          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist
WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... \
  WHATSAPP_VERIFY_TOKEN=... ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun dist/daemon.ts
```

The daemon listens on `PORT` (default 3000) for Meta webhook callbacks.
Configure the webhook URL in Meta's WhatsApp Business app dashboard. See
[`walkthroughs/39-channel-whatsapp.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/39-channel-whatsapp.md) for the
24-hour customer-service window, template-message gating, and HMAC-SHA256
signature verification.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile channels/whatsapp
bun run run channels/whatsapp
```
</details>
