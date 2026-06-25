# hello-channel-imessage — iMessage channel adapter

Minimal `target: channel` example wired for iMessage on macOS: a long-running
daemon that watches the local `chat.db` for inbound messages, runs one model
turn per message, and replies via AppleScript. macOS-only; the daemon assumes
it owns the user's iMessage account.

## Run it

```bash
cd starters/channels/imessage          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist
ANTHROPIC_AUTH_TOKEN=sk-ant-oat... bun dist/daemon.ts
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile channels/imessage
bun run run channels/imessage
```
</details>

You will be prompted to grant Full Disk Access (for `chat.db` read) and
Automation permissions (for AppleScript send). See
[`walkthroughs/40-channel-imessage.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/40-channel-imessage.md) for the
poll-vs-stream trade-off, contact-allowlist setup, and the macOS
permission flow.
