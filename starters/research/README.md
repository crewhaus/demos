# hello-research — autonomous-research vertical slice

Minimal `target: research` example: an agent that researches one
sub-question at a time using a small set of local source documents. Per
sub-question it loads sources via `Source(uri)`, extracts claims with
`Extract`, deduplicates, and produces a final cited synthesis.

## Run it

From the repo root:

```bash
bun install
bun run compile research                       # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bun run run research  # accepts a research prompt
```

The spec uses `file://` sources; point it at HTTP sources by editing the
research plan in `crewhaus.yaml`.

See [`recipes/07-autonomous-research.md`](../recipes/07-autonomous-research.md)
for the sub-question decomposition strategy, claim-extraction contract, and
the budget/iteration controls that cap runtime.
