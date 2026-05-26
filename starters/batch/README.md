# hello-batch — batch-worker vertical slice

Minimal `target: batch` example: a queue-driven worker that processes one
short-text job at a time and replies with a single concise sentence. Backed by
the in-memory queue adapter, so no external broker is required.

## Run it

From the repo root:

```bash
bun install
bun run compile batch                       # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bun run run batch  # consumes the queue
```

See [`walkthroughs/08-batch-worker.md`](../../walkthroughs/08-batch-worker.md) for the
narrative walkthrough, dataset shape, and graceful-shutdown semantics.
