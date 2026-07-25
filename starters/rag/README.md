# hello-rag — RAG-pipeline vertical slice

Minimal `target: pipeline` example: an agent grounded in a vector store via
the `Retrieve` tool. Each user question fetches top-K chunks before the
model answers, with `[N]` citation back to the source. Refuses out-of-corpus
questions explicitly.

## Run it

```bash
cd starters/rag                                       # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check   # writes dist/agent.ts, installs its deps, boots it
ANTHROPIC_API_KEY=sk-... bun dist/agent.ts            # indexes the corpus, then opens the REPL
```

`crewhaus run` only accepts `target: cli` and `target: browser`; a pipeline
spec is compile-only, so the bundle *is* the runtime. Prefer `--check` over a
bare `-o dist`: on CLI 0.4.0 only `--check` asserts the emitted bundle, writes
a `package.json` pinning its `@crewhaus/*` versions, and installs them. Without
that manifest the bundle still runs — Bun auto-installs the imports it can't
resolve — but it resolves whatever is newest on npm at boot, so what you tested
is not what ships.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/rag
bun run run starters/rag
```

</details>

The corpus is **inline**, under `indexing.documents` in the spec — six
`{ id, text }` entries that the compiler bakes into `dist/agent.ts` as a
literal. There is no corpus directory and no corpus env var: editing the
documents means recompiling, which is the trade for a bundle that indexes
the same bytes wherever you copy it. See the walkthrough's *Corpora that
live on disk* section for the generate-the-`documents:`-block pattern when
your corpus is files.

Boot prints `[pipeline] indexed 7 chunks`; `retrieve.defaultK` is `2`, so a
`Retrieve` call returns under a third of the store and the ranking actually
has to choose.

See [`walkthroughs/06-rag-pipeline.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/06-rag-pipeline.md) for the
chunker config, embedding-provider swap, and refusal-vs-best-effort policy.
