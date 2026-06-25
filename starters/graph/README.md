# hello-graph — stateful-graph vertical slice

Minimal `target: graph` example: a 3-node graph (plan → execute → summarise)
with typed edges. Each node receives upstream state and emits its own
output; the runtime materialises the DAG, schedules nodes when their inputs
are ready, and persists state per-execution.

## Run it

```bash
cd starters/graph                                       # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist             # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bunx crewhaus run crewhaus.yaml  # runs the graph end-to-end
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile graph
bun run run graph
```
</details>

See [`walkthroughs/05-stateful-graph.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/05-stateful-graph.md) for the
node-and-edge model, conditional edges, fan-out/fan-in, and the difference
between graph and crew.
