# hello-crew — multi-agent crew vertical slice

Minimal `target: crew` example: three named roles (researcher, writer,
critic) take turns under a shared session, each with its own instructions
and tool set. Demonstrates inter-role hand-off via `Delegate` and crew-level
permission scoping.

## Run it

```bash
cd starters/crew                                   # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist        # writes dist/{daemon,…}.ts
ANTHROPIC_API_KEY=sk-... bun dist/daemon.ts        # starts the crew daemon
```

The entry role (`researcher`) accepts the first message; subsequent turns
route to whichever role the entry role delegates to.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile crew
bun run run crew
```

</details>

See [`04-multi-agent-crew.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/04-multi-agent-crew.md) for
the role-routing model, the delegation contract, and the difference between
`target: crew` and `target: graph`.
