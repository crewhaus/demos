# hello-expert — a self-teaching domain expert

An agent that becomes a **verifiable expert in a field** and keeps getting
better on its own. It reads high-quality sources, commits the durable,
time-tested knowledge to **its own wiki**, recalls the right slice of that
wiki on every question, **reflects** to reconcile and re-verify what it
knows, and maintains a **living competency exam** so its expertise is
measured, not asserted. Crucially, it also learns **what to learn** — from a
real curriculum *and* from the gaps it hits when it can't confidently
answer.

Since CrewHaus v0.3.0 the whole mechanism is **built in**. The spec is two
knobs plus domain content:

```yaml
thredz: true                  # the hosted wiki = long-term memory (one env var)

learning:
  domain: specialty coffee brewing & extraction science
  curriculum: curriculum.md
  sources: ["sca.coffee", "*.edu", "baristahustle.com"]
  exam: { dataset: eval/dataset.jsonl, graders: eval/graders.yaml }
```

`thredz:` synthesizes the MCP server (`npx thredz-mcp`), delivers
`THREDZ_API_KEY` to it, registers the wiki tools under their bare names
(`wiki_recall`, `wiki_write`, `log_knowledge_gap`, …), and enforces
`private` visibility. `learning:` registers the shipped **`learning-loop`
skill** with your domain/curriculum/sources substituted in, gates in the
`/study` `/reflect` `/exam` commands, holds `wiki_write` to *no source, no
commit*, and wires the first-class exam. That Sources discipline is
backend-dependent: on a **local** `memory.wiki` backend the tool layer
enforces it deterministically (`wiki_write` rejects an uncited body); on
the **hosted thredz** backend this cli spec uses, it's the `learning-loop`
skill's standing instruction rather than a hard gate (`daemon.yaml`, which
stays local, is where you see the mechanical rejection). There is no
vendored server, no 150-line mechanism prompt, and no Bash shell-out —
those were this demo's scaffolding before the capability shipped.

The seed domain is **specialty coffee brewing & extraction science** —
evergreen fundamentals plus fast-moving research, crisp verifiable numbers,
and a real certification curriculum. See
[§ Point it at your field](#point-it-at-your-field).

> Walkthrough:
> [64 — The self-teaching expert](../../walkthroughs/64-self-teaching-expert.md)
> walks this starter end to end on the v0.3.0 surface.

## The loop

```
                    ┌─────────────────────────────────────────────┐
                    │  curriculum.md  +  logged knowledge gaps    │  ← learn WHAT to learn
                    │   (formal path)     (own blind spots)       │
                    └───────────────────────┬─────────────────────┘
                                            │  pick the next topic
                                            ▼
  high-quality sources ──►  STUDY  ──►  wiki_write  ──►  ┌───────────────┐
  (learning.sources,       (research,   (cited or        │  the wiki     │
   sources/, the web)       synthesise)  REJECTED)       │  (long-term   │
                                            ▲            │   memory)     │
   user question ──► RECALL ────────────────┼────────────┤               │
        │            answer + cite          │            └──────┬────────┘
        │            or log a gap ──────────┘                   │
        ▼                                              REFLECT (reconcile,
   EXAM (run_exam) ──► failures auto-logged as gaps    re-verify, re-signal,
        │                                              curate curriculum
        └──► ratings + exam ──► flywheel ──► gated, reviewed spec patch & exam)
```

Two shapes:

- **`crewhaus.yaml` (`target: cli`)** — the **interactive** expert on the
  hosted Thredz wiki. Ask it things; it answers from memory with citations.
  Drive `/study`, `/reflect`, `/exam` by hand.
- **`daemon.yaml` (`target: channel`)** — the **always-on** expert. A
  heartbeat fires every 6h and the built-in study rotation
  (`learning.study.on_heartbeat`) runs a bounded STUDY or REFLECT pass with
  no human in the loop (see [`HEARTBEAT.md`](HEARTBEAT.md)); it answers
  questions in Slack and turns 👍/👎 reactions into rating signal.
  *Wiki backend:* this daemon uses the **local** wiki (`memory.wiki`,
  files under `.crewhaus/wiki/`) as a deliberate choice — same tools, same
  skill, and it's where the mechanical `## Sources` gate is enforced. As
  of CrewHaus 0.4.0 `thredz:` is emit-wired on the channel shape too, so
  you can swap `memory.wiki` for `thredz: true` to share the cli's one
  hosted brain.

## Prerequisites

| Need | Why | Where |
|---|---|---|
| **Thredz API key with a wiki grant** (cli spec) | the expert's long-term memory | [thredz.crewhaus.ai](https://thredz.crewhaus.ai) — create a key, grant it wiki `read-write` via `/api/wiki/access` |
| **Anthropic key** (`ANTHROPIC_API_KEY`) | run the agent | — |
| **Search provider** (`CREWHAUS_SEARCH_*`) | `/study` reads the live web | any provider CrewHaus supports (brave, tavily, …) |
| **Slack app creds** (daemon only) | Slack Q&A | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |

Copy `.env.example` to `.env` and fill it in — Bun auto-loads `./.env`, so
run commands from inside this directory. A missing `THREDZ_API_KEY` fails
at boot with a clear message (exit 21), and a Thredz outage *degrades* the
run to local files instead of killing it.

## Run it (interactive)

```bash
cd starters/expert
cp .env.example .env        # add THREDZ_API_KEY + ANTHROPIC_API_KEY (+ search)
bunx crewhaus run crewhaus.yaml          # or: compile crewhaus.yaml -o dist
```

Then, in the REPL:

```
> What grind and ratio for a balanced V60?          # RECALL → cited answer
> /study                                             # learn the next topic
> /study refractometry                               # …or a specific one
> /reflect                                           # reconcile + re-verify
> /exam                                              # sit the exam (run_exam)
```

The first time you run `/study` the wiki is empty, so answers will honestly
say "I don't know that yet" and log gaps — then a study pass fills them in.
That cold-start-to-competent arc *is* the demo.

## Run it (always-on daemon)

`crewhaus run` is cli/browser-only and won't serve a channel daemon — use
the supervised dev loop (fine here: this spec has no local-path MCP
servers), or compile and run the bundle:

```bash
crewhaus dev daemon.yaml              # supervised: recompiles + relaunches on change
# — or, standalone:
bunx crewhaus compile daemon.yaml -o dist && bun install --cwd dist && bun dist/daemon.ts
```

A small status page comes up on `http://localhost:4173` (`gateway.ui`). For a
live demo, drop `heartbeat.every` to `5m` so you can watch a study pass fire.

## The four modes (the shipped `learning-loop` skill)

| Mode | Trigger | What it does |
|---|---|---|
| **Answer** | any question | `wiki_recall` first → answer **from memory, with slug citations** → if the wiki can't support it, say so and `log_knowledge_gap` (never bluff) |
| **Study** | `/study [topic]` | pick the next topic (**gaps → curriculum → frontier**), research high-quality sources via parallel `researcher` sub-agents, and `wiki_write` durable, cited, confidence-scored articles |
| **Reflect** | `/reflect` | surface stale/low-confidence articles, reconcile contradictions & duplicates, re-verify against primary sources, update quality signals, and curate `curriculum.md` + the exam |
| **Exam** | `/exam` | the `run_exam` tool runs `eval/dataset.jsonl` through `eval/graders.yaml` **in-process** (each question answered from the wiki in a fresh session); every failure is **logged as a knowledge gap automatically** |

The skill body ships with CrewHaus (`@crewhaus/default-skills`), with
`learning.domain` / `curriculum` / `sources` substituted at compile time. A
project-level `.crewhaus/skills/learning-loop/SKILL.md` overrides it if you
want to customize the discipline.

## Learning *what* to learn

The expert never picks topics at random. Every study pass chooses by priority:

1. **Logged knowledge gaps** — when it can't confidently answer (or fails an
   exam question), a gap is logged; those become the top study targets.
   (Learning from its own measured blind spots.)
2. **The curriculum ladder** in [`curriculum.md`](curriculum.md) — a real
   learning path (fundamentals → methods → measurement → frontier). It works
   down the ladder, ticking rungs it has mastered.
3. **The frontier** — recent, high-quality developments, weighted below the
   fundamentals.

`/reflect` edits `curriculum.md` itself — adding rungs for gaps it keeps
hitting — so the plan adapts to what the expert actually struggles with.

## Verifiable expertise: the exam + the flywheel

An expert should be *measurable*. [`eval/dataset.jsonl`](eval/dataset.jsonl)
is a competency exam and [`eval/graders.yaml`](eval/graders.yaml) an
`llm_judge` rubric. `/exam` sits it via the first-class `run_exam` tool —
no Bash permission, no shelling out to `crewhaus eval` — and failures flow
straight back into the study queue as gaps. The expert grows the exam as it
learns and never deletes a question it merely failed.

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

1. Change `learning.domain` (and the one-paragraph persona in
   `agent.instructions`) in both specs.
2. Replace [`curriculum.md`](curriculum.md) — its ladder with your field's
   real learning path (a degree syllabus, a certification outline, a
   canonical textbook's table of contents) — and `learning.sources` with
   your field's primary/peer-reviewed/standards domains.
3. Reseed [`sources/`](sources/) with a hand-checked canonical note or two,
   and [`eval/dataset.jsonl`](eval/dataset.jsonl) with gold Q&A for your
   field.

The mechanism — recall-then-answer, gaps-first learning, reflect-and-verify,
grow-the-exam — ships with CrewHaus and carries over unchanged.

## Files

```
expert/
  crewhaus.yaml            interactive expert (target: cli) — thredz: + learning:
  daemon.yaml              always-on expert (target: channel) — heartbeat study rotation
  curriculum.md            the learning ladder + source notes (agent-editable)
  HEARTBEAT.md             documents the built-in unattended study rotation
  sources/                 hand-checked seed notes to bootstrap from
  eval/dataset.jsonl       the competency exam (grows over time)
  eval/graders.yaml        the exam rubric (llm_judge)
  .env.example             keys: Anthropic, Thredz, search, Slack
```

## Notes & limits

- The wiki is the source of truth; the model's head is empty between turns.
  Cold start is honest by design: an empty wiki means "I don't know yet" +
  logged gaps until study fills it in.
- `/study` and heartbeat STUDY need a search provider to reach the live web;
  without one the expert still works from `sources/` and the wiki.
- Knowledge-gap logging is backend-aware: gaps land as Thredz tasks
  (`task_list`, tag `knowledge-gap`) on the hosted backend and as `[gap]`
  goals in the plan store locally — either way the next study pass lists
  them first.
