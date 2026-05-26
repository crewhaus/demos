# hello-channel-imessage — iMessage channel adapter

Minimal `target: channel` example wired for iMessage on macOS: a long-running
daemon that watches the local `chat.db` for inbound messages, runs one model
turn per message, and replies via AppleScript. macOS-only; the daemon assumes
it owns the user's iMessage account.

## Run it

From the repo root:

```bash
bun install
bun run compile channels/imessage
ANTHROPIC_AUTH_TOKEN=sk-ant-oat... bun run run channels/imessage
```

You will be prompted to grant Full Disk Access (for `chat.db` read) and
Automation permissions (for AppleScript send). See
[`walkthroughs/40-channel-imessage.md`](../../../walkthroughs/40-channel-imessage.md) for the
poll-vs-stream trade-off, contact-allowlist setup, and the macOS
permission flow.
