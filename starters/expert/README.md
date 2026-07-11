# hello-expert — a self-teaching domain expert

An agent that becomes a **verifiable expert in a field** and keeps getting
better on its own. It reads high-quality sources, commits the durable,
time-tested knowledge to **its own wiki** (Thredz), recalls the right slice
of that wiki with vector search on every question, **reflects** to reconcile
and re-verify what it knows, and maintains a **living competency exam** so
its expertise is measured, not asserted. Crucially, it also learns **what to
learn** — from a real curriculum *and* from the gaps it hits when it can't
confidently answer.

The seed domain is **specialty coffee brewing & extraction science** —
evergreen fundamentals plus fast-moving research, crisp verifiable numbers,
and a real certification curriculum. It's a single knob; see
[§ Point it at your field](#point-it-at-your-field).

> This is a showcase demo: it wires several CrewHaus capabilities (an MCP
> server, sub-agent fan-out, memory, feedback ratings, the eval harness, and
> the self-improvement flywheel) around one idea. Walkthrough:
> [64 — The self-teaching expert](../../walkthroughs/64-self-teaching-expert.md).

## The loop

```
                    ┌───────────────────────────────────────────┐
                    │  curriculum.md  +  logged knowledge gaps    │  ← learn WHAT to learn
                    │        (formal path)      (own blind spots) │
                    └───────────────────────┬─────────────────────┘
                                            │  pick the next topic
                                            ▼
  high-quality sources ──►  STUDY  ──►  wiki_write  ──►  ┌───────────────┐
  (curriculum allowlist,   (research,   (durable,        │  Thredz wiki  │
   sources/, the web)       synthesise)  cited, scored)  │  (long-term   │
                                            ▲            │   memory)     │
   user question ──► RECALL (vector) ───────┼────────────┤               │
        │            answer + cite          │            └──────┬────────┘
        │            or log a gap ──────────┘                   │
        ▼                                              REFLECT (reconcile,
   EXAM (grade vs eval/) ──► failures = gaps           re-verify, re-signal,
        │                                              prune, curate curriculum
        └──► ratings + exam ──► flywheel ──► gated, reviewed spec patch   & exam)
```

Two shapes, one brain:

- **`crewhaus.yaml` (`target: cli`)** — the **interactive** expert. Ask it
  things; it answers from memory with citations. Drive `/study`, `/reflect`,
  `/exam` by hand. Runs with just a model key + a Thredz key.
- **`daemon.yaml` (`target: channel`)** — the **always-on** expert. A
  **heartbeat** fires every 6h and runs a STUDY or REFLECT pass with no human
  in the loop (see [`HEARTBEAT.md`](HEARTBEAT.md)); it answers questions in
  Slack and turns 👍/👎 reactions into rating signal.

## Prerequisites

| Need | Why | Where |
|---|---|---|
| **Thredz API key with a wiki grant** | the expert's long-term memory | [thredz.crewhaus.ai](https://thredz.crewhaus.ai) — create a key, grant it wiki `read-write` via `/api/wiki/access` |
| **Anthropic key** (`ANTHROPIC_API_KEY`) | run the agent | — |
| **Search provider** (`CREWHAUS_SEARCH_*`) | `/study` reads the live web | any provider CrewHaus supports (brave, tavily, …) |
| **Slack app creds** (daemon only) | Slack Q&A | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |

`bun` is required (the Thredz MCP server runs under Bun). Copy `.env.example`
to `.env` and fill it in — Bun auto-loads `./.env` for both the agent and the
spawned MCP server, so **run every command from inside this directory**.

## Run it (interactive)

```bash
cd starters/expert
cp .env.example .env        # add THREDZ_API_KEY + ANTHROPIC_API_KEY (+ search)
bunx crewhaus compile crewhaus.yaml -o dist
bunx crewhaus run crewhaus.yaml
```

Then, in the REPL:

```
> What grind and ratio for a balanced V60?          # RECALL → cited answer
> /study                                             # learn the next topic
> /study refractometry                               # …or a specific one
> /reflect                                           # reconcile + re-verify
> /exam                                              # grade yourself
```

The first time you run `/study` the wiki is empty, so answers will honestly
say "I don't know that yet" and log gaps — then a study pass fills them in.
That cold-start-to-competent arc *is* the demo.

## Run it (always-on daemon)

```bash
bunx crewhaus compile daemon.yaml -o dist
bunx crewhaus run daemon.yaml         # listens on Slack; heartbeat studies/reflects
```

A small status page comes up on `http://localhost:4173` (`gateway.ui`). For a
live demo, drop `heartbeat.every` to `5m` so you can watch a study pass fire.

## The four modes

| Mode | Trigger | What it does |
|---|---|---|
| **Answer** | any question | `wiki_recall` first → answer **from memory, with slug citations** → if the wiki can't support it, say so and `log_knowledge_gap` (never bluff) |
| **Study** | `/study [topic]` | pick the next topic (**gaps → curriculum → frontier**), research high-quality sources via parallel `researcher` sub-agents, and `wiki_write` durable, cited, confidence-scored articles |
| **Reflect** | `/reflect` | surface stale/low-confidence articles, reconcile contradictions & duplicates, re-verify against primary sources, update quality signals, and curate `curriculum.md` + the exam |
| **Exam** | `/exam` | run `crewhaus eval` against `eval/dataset.jsonl`; each failure becomes a logged gap; new knowledge earns a new question |

## The Thredz wiki = long-term memory

[`thredz-mcp/server.ts`](thredz-mcp/server.ts) is a **zero-dependency stdio
MCP server** (one file, no npm install) that wraps the Thredz wiki + tasks
API. The runtime spawns it and exposes its tools as `thredz__*`:

| Tool | Thredz endpoint | Used for |
|---|---|---|
| `wiki_recall` | `GET /wiki/context` | **primary recall** — combined keyword + semantic bundle, called first on every question |
| `wiki_semantic_search` | `POST /wiki/search/semantic` | vector recall for conceptual queries |
| `wiki_search` | `GET /wiki/search` | keyword recall for exact terms/numbers |
| `wiki_get` | `GET /wiki/articles/{slug}` | read one article in full |
| `wiki_write` | `POST`/`PATCH /wiki/articles` | **upsert** a durable, cited article by slug |
| `wiki_list` | `GET /wiki/articles` | reflection — find the stalest / lowest-confidence articles |
| `wiki_related` | `GET /wiki/articles/{slug}/related` | reflection — detect duplicates/contradictions |
| `wiki_set_signals` | `PATCH /wiki/articles/{slug}/signals` | reflection — mark `verified`, set `confidenceScore` |
| `wiki_stats` | `GET /wiki/stats` | corpus health for a reflection summary |
| `log_knowledge_gap` | `POST /tasks` | record a blind spot as a Thredz task → next study target |

Point `THREDZ_API_BASE` at a local Thredz (`http://localhost:3000/api`) or the
desktop app (`http://127.0.0.1:3210/api`) instead of the hosted default.

## Learning *what* to learn

The expert never picks topics at random. Every study pass chooses by priority:

1. **Logged knowledge gaps** — when it can't confidently answer, it calls
   `log_knowledge_gap`; those become the top study targets. (Learning from
   its own measured blind spots.)
2. **The curriculum ladder** in [`curriculum.md`](curriculum.md) — a real
   learning path (fundamentals → methods → measurement → frontier). It works
   down the ladder, ticking rungs it has mastered. (Learning from a
   legitimate, structured path.)
3. **The frontier** — recent, high-quality developments, weighted below the
   fundamentals.

`/reflect` edits `curriculum.md` itself — adding rungs for gaps it keeps
hitting — so the plan adapts to what the expert actually struggles with.

## Verifiable expertise: the exam + the flywheel

An expert should be *measurable*. [`eval/dataset.jsonl`](eval/dataset.jsonl)
is a competency exam and [`eval/graders.yaml`](eval/graders.yaml) an
`llm_judge` rubric (per-question, so it grades open-ended answers against
each gold answer). `/exam` runs it; the expert grows it as it learns and
never deletes a question it merely failed.

Ratings (stars in the cli, 👍/👎 in Slack) plus the exam feed the
**self-improvement flywheel**:

```bash
crewhaus flywheel run \
  --dataset registry:hello-expert-ratings \
  --graders eval/graders.yaml --concurrency 1
```

It compiles → evals → optimizes → **gates** (a patch lands only if the exam
pass-rate strictly improves with zero regressions) → writes a reviewable
spec diff. Nothing auto-merges; `permissions` and `model` are off-limits to
the optimizer. See walkthrough
[56 — the flywheel](../../walkthroughs/56-self-improvement-flywheel.md).

## Point it at your field

Everything is domain-agnostic except the seed content. To make it an expert
in *your* field:

1. Change the domain sentence in `agent.instructions` (both `crewhaus.yaml`
   and `daemon.yaml`).
2. Replace [`curriculum.md`](curriculum.md) — its ladder with your field's
   real learning path (a degree syllabus, a certification outline, a
   canonical textbook's table of contents) and its allowlist with your
   field's primary/peer-reviewed/standards sources.
3. Reseed [`sources/`](sources/) with a hand-checked canonical note or two,
   and [`eval/dataset.jsonl`](eval/dataset.jsonl) with gold Q&A for your
   field.

The mechanism — recall-then-answer, gaps-first learning, reflect-and-verify,
grow-the-exam — carries over unchanged.

## Files

```
expert/
  crewhaus.yaml            interactive expert (target: cli) — the default
  daemon.yaml              always-on expert (target: channel) — heartbeat study/reflect
  thredz-mcp/server.ts     zero-dep stdio MCP server → the Thredz wiki (long-term memory)
  curriculum.md            the learning ladder + high-quality source allowlist (what to learn)
  HEARTBEAT.md             the daemon's per-tick STUDY/REFLECT playbook
  sources/                 hand-checked seed notes to bootstrap from
  eval/dataset.jsonl       the competency exam (grows over time)
  eval/graders.yaml        the exam rubric (llm_judge)
  .env.example             keys: Anthropic, Thredz, search, Slack
```

## Notes & limits

- The wiki is the source of truth; the model's head is empty between turns.
  If `THREDZ_API_KEY` is missing, the `thredz__*` tools return a clear error
  instead of crashing — but the expert can't recall or persist knowledge, so
  set it before a real run.
- `/study` and heartbeat STUDY need a search provider to reach the live web;
  without one the expert still works from `sources/` and the wiki.
- Cold start is honest by design: an empty wiki means "I don't know yet" +
  logged gaps until study fills it in.
