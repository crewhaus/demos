# hello-channel-whatsapp — WhatsApp Business channel adapter

Minimal `target: channel` example wired for WhatsApp Business: a long-running
daemon that receives Meta Graph webhook events, runs one model turn per
inbound customer message, and replies via the WhatsApp Business send-message
endpoint. Sessions keyed by WhatsApp phone number.

## Run it

From the repo root:

```bash
bun install
bun run compile channels/whatsapp
WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_ACCESS_TOKEN=... \
  WHATSAPP_VERIFY_TOKEN=... ANTHROPIC_AUTH_TOKEN=sk-ant-oat... \
  bun run run channels/whatsapp
```

The daemon listens on `PORT` (default 3000) for Meta webhook callbacks.
Configure the webhook URL in Meta's WhatsApp Business app dashboard. See
[`walkthroughs/39-channel-whatsapp.md`](../../../walkthroughs/39-channel-whatsapp.md) for the
24-hour customer-service window, template-message gating, and HMAC-SHA256
signature verification.
