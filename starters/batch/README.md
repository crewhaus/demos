# hello-batch — batch-worker vertical slice

Minimal `target: batch` example: a queue-driven worker that processes one
short-text job at a time and replies with a single concise sentence. Backed by
the in-memory queue adapter, so no external broker is required.

## Run it

```bash
cd starters/batch                                  # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist        # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bunx crewhaus run crewhaus.yaml   # consumes the queue
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile batch
bun run run batch
```

</details>

See [the batch-worker walkthrough](https://github.com/crewhaus/demos/blob/main/walkthroughs/08-batch-worker.md) for the
narrative walkthrough, dataset shape, and graceful-shutdown semantics.
