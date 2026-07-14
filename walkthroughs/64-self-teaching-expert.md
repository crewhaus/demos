---
test:
  spec: starters/expert/crewhaus.yaml
  packages:
    - packages/mcp-host
    - packages/eval-runner
    - packages/eval-optimizer-orchestrator
    - packages/target-channel-bot
---

# Recipe 64 — The self-teaching expert (memory + curriculum + a growing exam)

> **TODO — rewrite for the v0.3.0 learning surface.** The starter this
> recipe walks through has been rewritten on top of the first-class
> `thredz:` and `learning:` blocks, and this text still describes the
> pre-0.3.0 scaffolding. The delta to fold in:
>
> - `starters/expert/crewhaus.yaml` is now two knobs plus domain content:
>   `thredz: true` + a `learning:` block (domain, curriculum, sources,
>   exam) + a short domain persona. The ~150-line four-mode mechanism
>   prompt is gone — the shipped `learning-loop` skill carries it, with
>   domain/curriculum/sources substituted at compile time.
> - The vendored `thredz-mcp/server.ts` is deleted; `thredz: true`
>   synthesizes the `npx thredz-mcp` server, delivers `THREDZ_API_KEY` to
>   it (fail-fast at boot), and registers the tools under bare names
>   (`wiki_recall`, not `thredz__wiki_recall`).
> - `/study` `/reflect` `/exam` are real built-in slash commands now, and
>   `/exam` drives the first-class `run_exam` tool — a programmatic
>   eval-runner invocation, not a Bash shell-out to `crewhaus eval`; the
>   `bash` tool and its `crewhaus eval*` allowlist are gone from the spec.
>   Exam failures are logged as knowledge gaps automatically.
> - "No source, no commit" is enforced: with `learning:` on, `wiki_write`
>   rejects bodies without a `## Sources` section.
> - The daemon's HEARTBEAT.md playbook is now the built-in
>   `learning.study.on_heartbeat` rotation (gaps first, ~3:1
>   study:reflect, bounded ticks), baked into the compiled daemon; the
>   daemon currently learns into the local wiki (channel-shape thredz
>   wiring is a follow-up).
> - The examiner sub-agent is superseded by the exam graders.

**Pillar:** Pillar 2 — eval is active, not passive (an expert that *measures*
its expertise and improves it).
**Catalog modules:** `mcp-host` (§9), `memory-store`, `eval-runner`,
`grader-registry`, `eval-optimizer-orchestrator`, `feedback-distill`,
`target-channel-bot` (heartbeat).
**Starter:** [`starters/expert/`](../starters/expert/README.md).

Most "expert agent" demos are a system prompt plus RAG over a fixed corpus.
This recipe builds an expert that **grows** its own corpus over time, knows
the **edge** of what it knows, decides **what to learn next**, and keeps a
**living exam** so its expertise is verifiable rather than asserted.

It composes pieces you've already met:

- [Recipe 13 — MCP servers](13-mcp-servers.md) — the expert's long-term
  memory is a [Thredz](https://thredz.crewhaus.ai) wiki behind a local MCP
  server.
- [Recipe 06 — RAG pipeline](06-rag-pipeline.md) — recall-before-answer, but
  over memory the agent *wrote itself*.
- [Recipe 07 — Autonomous research](07-autonomous-research.md) — the STUDY
  pass, driven by a curriculum instead of a single fixed goal.
- [Recipe 12 — Eval harness](12-eval-harness.md) + [Recipe 56 — the
  flywheel](56-self-improvement-flywheel.md) — the exam and the gated,
  human-reviewed self-improvement loop.

## The idea

An expert is not a model with a big prompt. An expert is a **body of verified
knowledge**, a **sense of its own limits**, and a **discipline for closing
them**. This agent models all three:

```
   learn WHAT to learn  ──►  STUDY  ──►  write durable, cited knowledge
   (curriculum + gaps)       (research     to the wiki (long-term memory)
        ▲                     high-quality        │
        │                     sources)            ▼
   log a gap ◄── ANSWER ◄── RECALL (vector) ◄── the wiki
   (can't confidently        cite what you            │
    answer → study it)       actually know            ▼
                                              REFLECT: reconcile, re-verify,
   EXAM (grade vs gold) ──► fails become gaps  re-signal, prune, curate the
        └── ratings + exam ──► flywheel ──►     curriculum AND the exam
                               gated spec patch (reviewed by a human)
```

The seed domain in the starter is specialty-coffee brewing science — but the
domain is one knob (see the starter README's *Point it at your field*). The
mechanism is domain-agnostic.

## 1 — Long-term memory as an MCP server

The expert's memory is a Thredz wiki. [`thredz-mcp/server.ts`](../starters/expert/thredz-mcp/server.ts)
is a **single-file, zero-dependency** stdio MCP server that speaks the MCP
JSON-RPC protocol directly and wraps the Thredz wiki + tasks API. The runtime
spawns it and exposes its tools as `thredz__*`:

```yaml
mcp_servers:
  thredz:
    transport: stdio
    command: bun
    args: ["thredz-mcp/server.ts"]
```

The tools split cleanly by mode: `wiki_recall` / `wiki_semantic_search` /
`wiki_search` / `wiki_get` for **answering**, `wiki_write` (upsert-by-slug)
for **studying**, `wiki_list` / `wiki_related` / `wiki_set_signals` for
**reflecting**, and `log_knowledge_gap` (a Thredz task) for **learning what
to learn**. Writes are flagged so the permission + audit layers see them:

```yaml
tool_config:
  mcp:
    thredz:
      wiki_write: { destructive: true }
      wiki_set_signals: { destructive: true }
      log_knowledge_gap: { sideEffect: audit-and-allow }
```

The server reads `THREDZ_API_KEY` / `THREDZ_API_BASE` from the environment
(Bun auto-loads `./.env`), so no secrets live in the spec. Point the base at
a local or desktop Thredz to develop offline.

## 2 — Answer only from what you've verified

The one rule that makes it an expert and not a chatbot: **recall first, and
never bluff.** The system prompt makes the agent call `thredz__wiki_recall`
before it answers, cite the article slugs it used, and — when recall doesn't
support a confident answer — say so and call `thredz__log_knowledge_gap`
instead of inventing specifics. A logged gap is worth more than a confident
guess, because the gap becomes the next thing it studies.

## 3 — Learn *what* to learn

A study pass never picks topics at random. It chooses by priority:

1. **Its own logged knowledge gaps** — the blind spots it measured while
   answering or examining. (Learning from experience.)
2. **The next rung of [`curriculum.md`](../starters/expert/curriculum.md)** —
   a real learning ladder (fundamentals → methods → measurement → frontier)
   with a high-quality **source allowlist**. (Learning from a legitimate,
   structured path — a syllabus, a certification outline, a canonical text.)
3. **The frontier** — recent, high-quality developments, weighted below the
   time-tested fundamentals.

Then it researches — dispatching several read-only `researcher` sub-agents in
one turn so they run in parallel — separates **time-tested** from
**frontier/provisional** knowledge, and commits the durable, high-value bits
with `thredz__wiki_write`: a stable slug, a `## Sources` section, tags, and an
honest `confidenceScore`. Upsert, not duplicate.

## 4 — Reflect: improve the knowledge, not just grow it

Accumulation isn't understanding. The REFLECT pass surfaces the stalest and
lowest-confidence articles (`wiki_list`), finds contradictions and duplicates
(`wiki_related`), re-verifies shaky claims against a primary source, and
updates quality signals (`wiki_set_signals` — `verified`, `confidenceScore`).
It also **edits the curriculum** (ticking mastered rungs, adding rungs for
recurring gaps) and **grows the exam** — never deleting a question it merely
failed, because that's the gap it must close.

## 5 — A verifiable, living exam

[`eval/dataset.jsonl`](../starters/expert/eval/dataset.jsonl) is a competency
exam and [`eval/graders.yaml`](../starters/expert/eval/graders.yaml) an
`llm_judge` rubric — per-sample, because open-ended domain answers are graded
against each question's gold answer, not one fixed substring. Grade it:

```bash
crewhaus eval crewhaus.yaml \
  --dataset eval/dataset.jsonl --graders eval/graders.yaml --concurrency 1
```

Each failure is a diagnosed gap (logged for the next study pass); each newly
mastered topic earns a new question. The exam is always a fair, current test.

## 6 — Close the loop with the flywheel

Answer ratings (stars in the cli, 👍/👎 in Slack via the `feedback:` block)
plus the exam are the fitness function for the self-improvement flywheel
(Recipe 56):

```bash
crewhaus flywheel run \
  --dataset registry:hello-expert-ratings \
  --graders eval/graders.yaml --concurrency 1
```

It compiles → evals → optimizes → **gates** (a patch lands only if the exam
pass-rate strictly improves with zero per-sample regressions) → writes a
reviewable spec diff. Nothing auto-merges; `permissions` and `model` are
off-limits to the optimizer. The expert improves while you sleep, and you
review the diff in the morning.

## 7 — On a schedule (the daemon)

The interactive cli is the same brain you can also run as an always-on
daemon. [`daemon.yaml`](../starters/expert/daemon.yaml) (`target: channel`)
adds a **heartbeat** that fires every 6h and runs a STUDY or REFLECT pass
with no human in the loop, following
[`HEARTBEAT.md`](../starters/expert/HEARTBEAT.md):

```yaml
heartbeat:
  every: 6h
  instructions: |
    Heartbeat tick. Read HEARTBEAT.md and run the pass it selects (STUDY or
    REFLECT). Do real work, then log a one-line result.
```

That's the "regularly reads sources / reflects on its own" cadence: it
answers in Slack, studies and reflects on a timer, and turns reactions into
training signal — a domain expert that is awake, improving, and accountable
to an exam even when nobody's asking.

## Run it

```bash
cd starters/expert
cp .env.example .env       # THREDZ_API_KEY (+ wiki grant), ANTHROPIC_API_KEY, search keys
bunx crewhaus compile crewhaus.yaml -o dist
bunx crewhaus run crewhaus.yaml
#   > What grind and ratio for a balanced V60?     (recall + cite, or an honest gap)
#   > /study     /reflect     /exam
```

Cold start is honest: an empty wiki means "I don't know that yet" plus logged
gaps until a study pass fills them in. That arc — from empty to cited,
exam-passing expertise — is the demo.

## When NOT to use this

- **A fixed, curated corpus that rarely changes.** If the knowledge is stable
  and you own it, plain RAG ([Recipe 06](06-rag-pipeline.md)) is simpler —
  you don't need the study/reflect machinery.
- **A domain with no trustworthy sources.** The expert is only as good as its
  allowlist; garbage sources produce a confidently wrong expert. Curate
  `curriculum.md`'s allowlist first.
- **Before you have a Thredz key.** The wiki *is* the memory; without it the
  `thredz__*` tools return a clear error and the expert can't recall or
  persist anything.

## Pointers to source

- **MCP host (spawns the wiki server):** [`packages/mcp-host`](https://github.com/crewhaus/factory/blob/main/packages/mcp-host).
- **Heartbeat (scheduled study/reflect):** [`packages/target-channel-bot`](https://github.com/crewhaus/factory/blob/main/packages/target-channel-bot).
- **Exam runner + judge rubric:** [`packages/eval-runner`](https://github.com/crewhaus/factory/blob/main/packages/eval-runner), [`packages/eval-judge`](https://github.com/crewhaus/factory/blob/main/packages/eval-judge).
- **Flywheel:** [`packages/eval-optimizer-orchestrator`](https://github.com/crewhaus/factory/blob/main/packages/eval-optimizer-orchestrator).
- **Thredz wiki API:** [thredz.crewhaus.ai](https://thredz.crewhaus.ai).
