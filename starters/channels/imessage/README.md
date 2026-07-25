# hello-channel-imessage — iMessage channel adapter

Minimal `target: channel` example wired for iMessage on macOS: a long-running
daemon that registers the host-bound iMessage adapter — inbound by reading the
local `chat.db`, outbound by driving Messages.app over AppleScript. One model
turn per message, replied in the same conversation, once something drives the
poll ([below](#nothing-polls-until-you-poll) — the generated daemon does not).
macOS-only, and it assumes it owns the user's iMessage account, so it refuses
to start until you say so.

## Run it

```bash
cd starters/channels/imessage          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check   # --check writes dist/package.json and installs the bundle's @crewhaus deps
CREWHAUS_IMESSAGE_HOST_ENABLED=1 \
  ANTHROPIC_AUTH_TOKEN=sk-ant-oat... bun dist/daemon.ts
```

`CREWHAUS_IMESSAGE_HOST_ENABLED=1` is the kill switch, and it is not optional:
without it the adapter refuses to construct (`IMessageAdapterError`, exit 1)
before a socket is opened or a row of `chat.db` is read. Off macOS it refuses
the same way. With it, the daemon serves the gateway on `PORT` (3000 by
default).

## Nothing polls until you poll

The generated `daemon.ts` registers the adapter and serves the gateway — it
never starts a poll loop, so a freshly compiled bundle answers nobody. That is
the adapter's design, not an oversight: inbound iMessage has no webhook, so the
adapter exposes `pollNewMessages()` (each call drains everything past the
cursor persisted in `.crewhaus/imessage-cursor.json`) and the host picks the
cadence — a `setInterval` in your own entrypoint, a cron, an on-demand drain.
Feed the returned events to the bundle's session router and replies go out over
AppleScript.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/channels/imessage
CREWHAUS_IMESSAGE_HOST_ENABLED=1 bun run run starters/channels/imessage
```
</details>

macOS asks for Full Disk Access (to read `chat.db`) and Automation permission
(for the AppleScript send) at the first poll and the first reply — not at
boot, which touches neither. See
[`walkthroughs/40-channel-imessage.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/40-channel-imessage.md) for why
the adapter is host-bound, the cursor query it runs against `chat.db`,
handle validation, and the macOS permission flow.
