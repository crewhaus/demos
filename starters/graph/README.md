# hello-graph — stateful-graph vertical slice

Minimal `target: graph` example: a 3-node graph (plan → execute → summarise)
with typed edges. Each node receives upstream state and emits its own
output; the runtime materialises the DAG, schedules nodes when their inputs
are ready, and persists state per-execution.

## Run it

From the repo root:

```bash
bun install
bun run compile graph                       # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bun run run graph  # runs the graph end-to-end
```

See [`walkthroughs/05-stateful-graph.md`](../../walkthroughs/05-stateful-graph.md) for the
node-and-edge model, conditional edges, fan-out/fan-in, and the difference
between graph and crew.
