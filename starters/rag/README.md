# hello-rag — RAG-pipeline vertical slice

Minimal `target: pipeline` example: an agent grounded in a vector store via
the `Retrieve` tool. Each user question fetches top-K chunks before the
model answers, with `[N]` citation back to the source. Refuses out-of-corpus
questions explicitly.

## Run it

```bash
cd starters/rag                           # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist   # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bunx crewhaus run crewhaus.yaml  # opens an interactive REPL
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile rag
bun run run rag
```

</details>

The spec ships with a small in-process vector index over `./docs/`. To
point it at your own corpus, set `RAG_CORPUS_DIR=...`.

See [`walkthroughs/06-rag-pipeline.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/06-rag-pipeline.md) for the
chunker config, embedding-provider swap, and refusal-vs-best-effort policy.
