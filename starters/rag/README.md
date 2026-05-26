# hello-rag — RAG-pipeline vertical slice

Minimal `target: pipeline` example: an agent grounded in a vector store via
the `Retrieve` tool. Each user question fetches top-K chunks before the
model answers, with `[N]` citation back to the source. Refuses out-of-corpus
questions explicitly.

## Run it

From the repo root:

```bash
bun install
bun run compile rag                       # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bun run run rag  # opens an interactive REPL
```

The spec ships with a small in-process vector index over `./docs/`. To
point it at your own corpus, set `RAG_CORPUS_DIR=...`.

See [`recipes/06-rag-pipeline.md`](../recipes/06-rag-pipeline.md) for the
chunker config, embedding-provider swap, and refusal-vs-best-effort policy.
