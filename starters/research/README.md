# hello-research — autonomous-research vertical slice

Minimal `target: research` example: an agent that researches one
sub-question at a time using a small set of local source documents. Per
sub-question it loads sources via `Source(uri)`, extracts claims with
`Extract`, deduplicates, and produces a final cited synthesis.

## Run it

```bash
cd starters/research          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist          # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bunx crewhaus run crewhaus.yaml  # accepts a research prompt
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile research
bun run run research
```
</details>

The spec uses `file://` sources; point it at HTTP sources by editing the
research plan in `crewhaus.yaml`.

See [`walkthroughs/07-autonomous-research.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/07-autonomous-research.md)
for the sub-question decomposition strategy, claim-extraction contract, and
the budget/iteration controls that cap runtime.
