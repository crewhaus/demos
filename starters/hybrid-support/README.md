# hybrid-support

A support agent that **drafts on a cheap model with read-only tools, has a
stronger model grade the draft, and re-runs the failures on the strong
model** — declared, not hand-wired. It is the 0.6.0 release's motivating
scenario, small enough to read in one sitting.

## The shape of it

| file | what it holds |
|---|---|
| `crewhaus.yaml` | the `models:` roster, the two-lane `model_pool`, the cascade, and the checker |
| `notes/orders.md` | four order notes — the material the cheap lane reads |
| `bin/refund-window.sh` | the refund rule in code, so no model gets an opinion about it |
| `eval/dataset.jsonl` | six samples: three the cheap lane should settle, three that need the strong one |
| `eval/graders.yaml` | one `expected_contains` grader — each sample's own gold is the needle |

Three profiles, named once and referenced everywhere:

- **`$fast`** — `claude-haiku-4-5`, 2048 output tokens, `temperature: 0.2`,
  and a per-model instructions overlay telling it to answer short or admit
  the notes do not settle it.
- **`$strong`** — `claude-opus-5` with `thinking: { effort: high }`.
- **`$checker`** — `claude-sonnet-5`, the in-loop judge.

The cheap lane is narrowed **as a pool candidate**, not as a profile:
`tools: [read, grep]` (subset-only — never additive), `permissions: { deny:
["Bash(**)"] }`, and `cost: { max_usd: 0.50 }`, which makes the lane
ineligible once it has spent its share rather than ending the run. The
strong lane keeps the shape's full toolset, including the `bash` that runs
`bin/refund-window.sh`.

## Run it

Self-contained — run it from its own directory:

```bash
cd starters/hybrid-support   # if you copied it elsewhere, cd into that copy
cp .env.example .env         # ANTHROPIC_API_KEY

# 1 — read the route before you spend anything. Offline, no key.
bunx crewhaus models explain
bunx crewhaus models audit          # pricing coverage + parameter acceptance

# 2 — talk to it. Easy turns take the cheap lane; a draft that fails the
#     checker is re-run on the strong one.
bunx crewhaus run crewhaus.yaml
#   "has order A-1041 arrived?"                      → cheap lane, from notes/
#   "A-1043 was delivered 2026-08-14 — refund still open today?"
#                                                    → needs bash, so the
#                                                      cheap lane cannot
#                                                      answer it alone

# 3 — see what actually happened, per turn
bunx crewhaus route explain <sessionId>
bunx crewhaus route status --by profile

# 4 — measure the two arms against each other instead of guessing
bunx crewhaus eval crewhaus.yaml \
  --dataset eval/dataset.jsonl --graders eval/graders.yaml \
  --models '$fast,$strong' --record --seed 42
bunx crewhaus eval leaderboard .crewhaus/evals/<matrix-dir>
```

Quote `'$fast'` on any command line — an unquoted `$fast` is expanded away
by the shell before the CLI ever sees it.

## What to look for

- **`models explain` is the whole route on one screen** — every slot, what
  its `$profile` resolved to, the pinned params, the strategy in one
  sentence, and the per-shape carry/emit verdict for `cli`.
- **The cheap lane genuinely cannot reach `bash`.** Ask it the A-1043
  refund question and watch it decline rather than invent a window; the
  strong lane runs the script.
- **`route explain <sessionId>`** replays each turn's decision — which arm
  served, why, and whether the turn escalated — from the durable
  `model_route` lines, so the explanation is a record and not a
  reconstruction.
- **The leaderboard refuses to name a winner it cannot support.** Six
  samples is below its power floor, so it reports `UNDERPOWERED` instead of
  a leader. That is the honest answer, and it is the point.

## Gotchas

- **`crewhaus route explain` needs a real session**, so it only says
  anything after a run with a credential.
- **Per-model narrowing lives on the pool candidate.** A `$profile`
  carrying `tools` / `permissions` / `cost` that is referenced from a
  single-model slot like `agent.model` is refused by the compiler with a
  message saying exactly that — a single-model serving slot has no
  per-candidate plan carrier, so a narrower profile would have served with
  the shape's full toolset. Declare the narrowing on the candidate.
- **`bin/refund-window.sh` needs `python3`** for its date arithmetic (every
  macOS and Linux box the rest of this repo assumes already has it).

## Walkthrough

[Recipe 75 — Hybrid models: cheap worker, strong judge](../../walkthroughs/75-hybrid-models.md)
walks this starter end to end and covers the parts it deliberately leaves
out: `/model` directives, routing rules, the classifier policy, the
shadow lane, and `models propose`.
