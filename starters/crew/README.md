# hello-crew — multi-agent crew vertical slice

Minimal `target: crew` example: three named roles (researcher, writer,
critic) take turns under a shared session, each with its own instructions
and tool set. Demonstrates inter-role hand-off via `Delegate` and crew-level
permission scoping.

## Run it

From the repo root:

```bash
bun install
bun run compile crew                       # writes dist/{daemon,…}.ts
ANTHROPIC_API_KEY=sk-... bun run run crew  # starts the crew daemon
```

The entry role (`researcher`) accepts the first message; subsequent turns
route to whichever role the entry role delegates to.

See [`walkthroughs/04-multi-agent-crew.md`](../../walkthroughs/04-multi-agent-crew.md) for
the role-routing model, the delegation contract, and the difference between
`target: crew` and `target: graph`.
