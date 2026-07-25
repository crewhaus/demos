# hello-crew — multi-agent crew vertical slice

Minimal `target: crew` example: three named roles (researcher, writer,
critic) take turns under a shared session, each with its own instructions.
Demonstrates inter-role hand-off via `Handoff`, peer questions via
`SendMessage`, and crew-level permission scoping.

No role declares a tool. The crew runtime composes a `Handoff` and a
`SendMessage` into every role's turn — one target per peer — and pre-allows
both, so the baton is a property of the shape rather than something the spec
wires up.

## Run it

```bash
cd starters/crew                                   # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check   # --check writes dist/package.json and installs the bundle's @crewhaus deps
echo "Topic: rolling out vector-search to production" \
  | ANTHROPIC_API_KEY=sk-... bun dist/daemon.ts       # the topic arrives on stdin
```

The daemon takes its topic on **stdin**, runs the crew to completion, and
streams the roles' output plus one JSON event per transition —
`role_start`/`role_end`, `handoff`, `a2a_message`, `crew_done`. Given nothing
on stdin it writes `[crew] no input on stdin` and exits 2: it is a one-shot
pipeline, not a server.

The entry role (`researcher`) accepts the topic; subsequent turns route to
whichever role the current role hands off to.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/crew
echo "Topic: rolling out vector-search to production" | bun run run starters/crew
```

</details>

See [`04-multi-agent-crew.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/04-multi-agent-crew.md) for
the role-routing model, the two auto-injected tools, and the difference between
`target: crew` and `target: graph`.
