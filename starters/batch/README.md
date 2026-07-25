# hello-batch — batch-worker vertical slice

Minimal `target: batch` example: a queue-driven worker that pulls short-text
jobs off a queue — `concurrency: 4`, so four are in flight at once — and
replies to each with a single concise sentence. Backed by the in-memory queue
adapter, so no external broker is required.

## Run it

```bash
cd starters/batch                                      # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check    # writes dist/agent.ts and installs its deps
ANTHROPIC_API_KEY=sk-... bun dist/agent.ts             # drains the 8 seeded jobs, then exits
```

You get a `job_start` / `job_end` pair per job plus each reply, then
`queue_idle`, `drain_start` / `drain_end`, and `worker_stop`. With four jobs in
flight the replies interleave; `crewhaus sessions tail --no-follow` shows one
job's prompt and answer on their own.

> A batch worker is not a chat, so `crewhaus run` rejects it — `run` supports
> `target: cli` and `browser` only, and every other shape ships as a compiled
> bundle you boot yourself. `--check` is also what writes the bundle's
> `package.json` and `bun.lock` on CLI 0.4.0; a plain `compile -o dist` emits
> only `agent.ts`, so `bun install --cwd dist` has no manifest to install from
> and exits 1.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/batch
bun run run starters/batch
```

</details>

See [the batch-worker walkthrough](https://github.com/crewhaus/demos/blob/main/walkthroughs/08-batch-worker.md) for the
narrative walkthrough, dataset shape, and graceful-shutdown semantics.
