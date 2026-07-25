# hello-research — autonomous-research vertical slice

Minimal `target: research` example: an agent that researches one sub-question
at a time using a small set of local source documents. The bundle decomposes
the spec's `goal` into `branchingFactor` sub-questions, then runs one branch
per sub-question. A branch gets exactly two research tools — `Source(uri)`
loads a fenced document, `CiteFact(uri, snippet, supportingClaim?)` records a
quote — and ends with its own 2–3 sentence answer. There is no extraction tool
and no summarisation tool; the "at most 2 verbatim snippets" rule is agent
instructions, and `CiteFact` records whatever snippet it is handed without
checking it against the loaded body.

Each run writes `.crewhaus/research/<runId>/report.md`, and that report is a
transcript rather than an essay: the goal as the title, one `##` section per
sub-question holding that branch's answer verbatim, then a numbered
`## Citations` list deduplicated by URL (a file cited by three branches is one
entry). Nothing merges the branches — two branches that disagree both ship —
and if no branch ever calls `CiteFact`, the `## Citations` block is omitted
with no warning.

## Run it

```bash
cd starters/research                                   # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check    # writes dist/agent.ts and installs its deps
ANTHROPIC_API_KEY=sk-... bun dist/agent.ts             # researches the goal that ships in the spec
```

The last line of the run names the report it wrote:

```
{"kind":"run_done","runId":"run_…","reportPath":".crewhaus/research/run_…/report.md","citations":2}
```

Three flags override the spec at launch: `--goal "<question>"` swaps the
question, `--branching <n>` changes how many sub-questions it splits into, and
`--resume <runId>` continues a run that stopped at `maxDurationMs` — completed
branches are replayed from `state.json` instead of re-researched.

> A research run is not a chat, so `crewhaus run` rejects it — `run` supports
> `target: cli` and `browser` only, and every other shape ships as a compiled
> bundle you boot yourself. `--check` is also what writes the bundle's
> `package.json` and `bun.lock` on CLI 0.4.0; a plain `compile -o dist` emits
> only `agent.ts`, so `bun install --cwd dist` has no manifest to install from
> and exits 1.

The agent's whole world is `retrieve.allowedFileRoots` (`./sources` here,
harness-relative so a copy works anywhere): the bundle walks those roots and
prepends the `file://` URI list to every branch's prompt. To research over
HTTP, add the origins to `retrieve.allowedOrigins` — but nothing enumerates
the web for you, so the URL has to arrive in the `goal:` or in the agent
instructions.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/research
bun run run starters/research
```
</details>

See [`walkthroughs/07-autonomous-research.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/07-autonomous-research.md)
for the sub-question decomposition strategy, the two auto-injected tools, and
the budget/iteration controls that cap runtime.
