# hello-graph — stateful-graph vertical slice

Minimal `target: graph` example: a 3-node graph (plan → execute → summarise)
wired by two explicit edges. Each node receives the upstream state and adds its
own output under its node name; the engine walks the edges in declaration
order, checkpoints the state after every node, and pauses at the `hitl:` gate
on `execute` until a human decides. The edges here are untyped —
`crewhaus compile crewhaus.yaml --emit-ir` prints bare `from`/`to` and every
node is handed the whole state object.

## Run it

```bash
cd starters/graph                                      # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check    # writes dist/agent.ts and installs its deps
echo 'Draft a two-line launch note for this starter.' | ANTHROPIC_API_KEY=sk-... bun dist/agent.ts
```

A graph has no REPL — the bundle reads its input from stdin. `plan` and
`execute` run, then the gate stops the run and prints the line that restarts
it:

```
paused at execute: "Approve execute and continue to summarise?" — checkpoint=ckpt_… run=grun_…
to resume: bun …/dist/agent.ts --resume grun_… <decision>
```

```bash
ANTHROPIC_API_KEY=sk-... bun dist/agent.ts --resume grun_… approve   # execute replays, then summarise
```

Every run is a directory of checkpoints under `.crewhaus/graphs/<graphRunId>/`
(`_meta.json` plus one `ckpt_….json` per saved state), so you can also
`--branch-from <graphRunId> <checkpointId>` to explore a second continuation.

> A graph is not a chat, so `crewhaus run` rejects it — `run` supports
> `target: cli` and `browser` only, and every other shape ships as a compiled
> bundle you boot yourself. `--check` is also what writes the bundle's
> `package.json` and `bun.lock` on CLI 0.4.0; a plain `compile -o dist` emits
> only `agent.ts`, so `bun install --cwd dist` has no manifest to install from
> and exits 1.

> On CLI 0.4.0 the `hitl:` gate is asked **after** the gated node's model turn:
> execute's draft streams past, the pause checkpoints the state from *before*
> execute, and approving replays execute from the top — a second model call for
> the same node.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/graph
echo 'Draft a two-line launch note for this starter.' | bun run run starters/graph
```
</details>

See [`walkthroughs/05-stateful-graph.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/05-stateful-graph.md) for the
node-and-edge model, conditional edges, per-node tools, branching from a
checkpoint, and the difference between graph and crew.
