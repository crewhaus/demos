---
test:
  spec: starters/expert/crewhaus.yaml
  packages:
    - packages/memory-service
    - packages/wiki-store
    - packages/tool-wiki
    - packages/default-skills
    - packages/eval-runner
    - packages/target-channel-bot
---

# Recipe 64 — The self-teaching expert (memory + curriculum + a growing exam)

**Pillar:** Pillar 2 — eval is active, not passive (an expert that *measures*
its expertise and improves it).
**Catalog modules:** `memory-service` (the composition root), `wiki-store` /
`tool-wiki`, `default-skills` (the shipped `learning-loop` skill),
`eval-runner` (the in-process exam), `grader-registry`,
`eval-optimizer-orchestrator`, `target-channel-bot` (heartbeat study).
**Starter:** [`starters/expert/`](../starters/expert/README.md).

Most "expert agent" demos are a system prompt plus RAG over a fixed corpus.
This recipe builds an expert that **grows** its own corpus over time, knows
the **edge** of what it knows, decides **what to learn next**, and keeps a
**living exam** so its expertise is verifiable rather than asserted.

Since CrewHaus v0.3.0 the whole mechanism **ships with the product**. The
spec is two knobs plus domain content:

```yaml
thredz:                       # hosted wiki = long-term memory
  api_key: $THREDZ_API_KEY
  space: coffee-expert        # 0.5.0 — this agent's own memory boundary

learning:
  domain: specialty coffee brewing & extraction science
  curriculum: curriculum.md
  sources: ["sca.coffee", "*.edu", "baristahustle.com"]
  exam: { dataset: eval/dataset.jsonl, graders: eval/graders.yaml }
```

An earlier iteration of this starter proved the loop with ~150 lines of
mechanism prompt, a vendored MCP server, and a Bash shell-out for the exam.
All of that scaffolding is gone — v0.3.0 turned it into the `thredz:` and
`learning:` blocks, and this recipe now walks the productized surface.

It composes pieces you've already met:

- [Recipe 13 — MCP servers](13-mcp-servers.md) — `thredz:` *synthesizes* the
  memory server; you never declare it under `mcp_servers:`.
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
   log a gap ◄── ANSWER ◄── RECALL (hybrid) ◄── the wiki
   (can't confidently        cite what you            │
    answer → study it)       actually know            ▼
                                              REFLECT: reconcile, re-verify,
   EXAM (run_exam) ──► fails become gaps       re-signal, prune, curate the
        └── ratings + exam ──► flywheel ──►    curriculum AND the exam
                               gated spec patch (reviewed by a human)
```

The seed domain in the starter is specialty-coffee brewing science — but the
domain is one knob (see the starter README's *Point it at your field*). The
mechanism is domain-agnostic and ships with CrewHaus.

## 1 — Long-term memory is one knob

The expert's memory is a [Thredz](https://thredz.crewhaus.ai) wiki, and the
entire integration is one knob:

```yaml
thredz: true    # ≡ api_key: $THREDZ_API_KEY
```

The starter spells that shorthand out, because 0.5.0 adds a second knob
worth naming — the wiki **space** this expert's memory lives in:

```yaml
thredz:
  api_key: $THREDZ_API_KEY
  space: coffee-expert
```

The compiler synthesizes the MCP server entry (`npx -y thredz-mcp@0.3.0`), delivers
`THREDZ_API_KEY` into the child process through the v0.3.0 secret machinery
(fail-fast at boot with a clear message and exit 21 when it's missing — the
key never lands in compiled artifacts), enforces `private` visibility by
default, and registers the tools under **bare names**: `wiki_recall`, not
`thredz__wiki_recall`. That last detail matters — skills, permission rules,
and `tool_config` entries use one vocabulary whether the wiki is hosted or
local files under `.crewhaus/wiki/`.

The tools split cleanly by mode: `wiki_recall` / `wiki_semantic_search` /
`wiki_search` / `wiki_get` for **answering**, `wiki_write` (upsert-by-slug)
for **studying**, `wiki_list` / `wiki_related` / `wiki_set_signals` for
**reflecting**, and `log_knowledge_gap` for **learning what to learn**.
Writes are destructive + justification-gated by default, so the permission
and audit layers see them without any `tool_config` boilerplate.

Failure semantics are honest: a lapsed subscription or a Thredz outage
*degrades* the run (clear per-call errors, wiki temporarily unavailable)
instead of killing a local-first harness.

### Spaces, and why this starter needs two keys

A Thredz **wiki space** is a named memory boundary inside one account. A
`shared` space is readable by every wiki-enabled key on the account; an
`individual` space is readable only by the key that owns it. `space:`
lowers to the synthesized server's `THREDZ_DEFAULT_SPACE`, so every
`wiki_*` call is scoped without the agent having to remember to scope it.

A space's *type* is chosen when the space is created — over the API, or
by the agent itself through the two tools new in `thredz-mcp@0.3.0`,
`wiki_space_list` and `wiki_space_create` — not in the spec. The compiler
therefore can't validate it, and doesn't cross-check `visibility:`
against it: inside a space the space's own type decides who can read, and
the `private` default named above stops applying. (Both specs allow
`wiki_space_list` outright; neither allows `wiki_space_create`, which
spends plan quota — it stays justification-gated, so creating a space is
your call.)

Then the limit that shapes any multi-agent setup: **one individual space
per API key** — a hard Thredz limit, where a second one comes back `409
individual_space_exists` — and `thredz-mcp` reads exactly one
`THREDZ_API_KEY` per process. Chain those:

```
per-agent private memory  ⇒  one key per agent  ⇒  one server process per agent
```

That is why this starter's two specs carry two keys.
[`crewhaus.yaml`](../starters/expert/crewhaus.yaml) studies into
`coffee-expert` on `$THREDZ_API_KEY`;
[`daemon.yaml`](../starters/expert/daemon.yaml) (§8) studies into
`coffee-daemon` on `$THREDZ_DAEMON_KEY`, and neither key can read the
other's space. Sharing one brain across both is the *other* choice, and
it's equally deliberate: give both specs the same key and the same space
(what [Recipe 73](73-trading-advisor.md) does), or point them at a
**shared** space, which every wiki-enabled key on the account can read.

On a **crew** the same arithmetic is one block instead of two files.
`thredz.roles` (crew-only) gives a role its own key and space — and its
own npx child — while every role without an entry rides the crew-wide
block and shares one brain:

```yaml
thredz:
  visibility: private            # the crew-wide default every role inherits
  roles:
    researcher: { api_key: $THREDZ_KEY_RESEARCHER, space: researcher-notes }
    editor:     { api_key: $THREDZ_KEY_EDITOR,     space: editor-notes }
```

Spaces are a paid-plan capability: Pro allows 5 shared and 10 individual
spaces across at most 10 keys, Scale 25 and 50 across 50. Free and
Starter accounts have no spaces at all and keep the unspaced wiki — drop
`space:` from both specs there and everything else in this recipe is
unchanged.

## 2 — The `learning:` block

`learning:` is the discipline. It registers the shipped **`learning-loop`
skill** (from `@crewhaus/default-skills`) with your `domain`, `curriculum`,
and `sources` substituted at compile time, gates in the `/study`, `/reflect`,
and `/exam` slash commands, wires the first-class exam, and — because
learning requires a wiki — refuses to compile without `thredz:` or
`memory.wiki`. There is no mechanism prompt left to write; what remains in
[`crewhaus.yaml`](../starters/expert/crewhaus.yaml) is one sentence of domain
persona and a read-only `researcher` sub-agent.

The skill is four modes with one rule each — the sections below walk them.
A project-level `.crewhaus/skills/learning-loop/SKILL.md` overrides the
shipped body by name if you want to customize the discipline.

## 3 — ANSWER: only from what you've verified

The one rule that makes it an expert and not a chatbot: **recall first, and
never bluff.** The `learning-loop` skill makes the agent call `wiki_recall`
before it answers, cite the article slugs it used, and — when recall doesn't
support a confident answer — say so and call `log_knowledge_gap` instead of
inventing specifics. A logged gap is worth more than a confident guess,
because the gap becomes the next thing it studies.

## 4 — STUDY: learn *what* to learn

A study pass (`/study`, or a heartbeat tick in the daemon) never picks topics
at random. It chooses by priority:

1. **Its own logged knowledge gaps** — the blind spots it measured while
   answering or examining. (Learning from experience.)
2. **The next rung of [`curriculum.md`](../starters/expert/curriculum.md)** —
   a real learning ladder (fundamentals → methods → measurement → frontier).
   `learning.sources` is the high-quality allowlist — and it is deliberately
   NOT optimizer-tunable, because an allowlist is security, not a quality
   knob.
3. **The frontier** — recent, high-quality developments, weighted below the
   time-tested fundamentals.

Then it researches — dispatching several read-only `researcher` sub-agents in
one turn so they run in parallel — separates **time-tested** from
**frontier/provisional** knowledge, and commits the durable, high-value bits
with `wiki_write`: a stable slug, a `## Sources` section, tags, and an honest
confidence score. Upsert, not duplicate.

**"No source, no commit" — how hard the gate is depends on the backend.**
On a **local** `memory.wiki` backend, `learning:` stamps the tool layer so
`wiki_write` deterministically *rejects* any body without a `## Sources`
section — a prompt-only plea turned into write-path governance. On the
**hosted `thredz:`** backend both specs in this starter use, `wiki_write`
is a thredz-mcp pass-through with no such gate, so the same discipline
rides in the `learning-loop` skill's instructions instead. Either way the
rule holds; only the enforcement layer differs — and you can see the
mechanical version live by deleting `daemon.yaml`'s `thredz:` block,
which drops it back onto the `memory.wiki` block underneath.

## 5 — REFLECT: improve the knowledge, not just grow it

Accumulation isn't understanding. `/reflect` surfaces the stalest and
lowest-confidence articles (`wiki_list`), finds contradictions and duplicates
(`wiki_related`), re-verifies shaky claims against a primary source, and
updates quality signals (`wiki_set_signals`). Supersede, never delete —
prior versions stay retrievable. It also **edits the curriculum** (ticking
mastered rungs, adding rungs for recurring gaps) and **grows the exam** —
never deleting a question it merely failed, because that's the gap it must
close.

## 6 — A verifiable, living exam

[`eval/dataset.jsonl`](../starters/expert/eval/dataset.jsonl) is a competency
exam and [`eval/graders.yaml`](../starters/expert/eval/graders.yaml) an
`llm_judge` rubric — per-sample, because open-ended domain answers are graded
against each question's gold answer, not one fixed substring.

`/exam` sits it via the first-class **`run_exam` tool**: a programmatic
eval-runner invocation, in-process — each question is answered from the wiki
in a fresh single-turn session, and per-sample artifacts land under
`.crewhaus/evals/`. No Bash permission, no shelling out to `crewhaus eval`
(the earlier scaffolding's allowlist hack is gone from the spec entirely).
**Every failed question is logged as a knowledge gap automatically**, so
failures flow straight back into the study queue: each failure is a
diagnosed gap; each newly mastered topic earns a new question. The exam is
always a fair, current test.

You can still grade from the outside, CI-style:

```bash
crewhaus eval crewhaus.yaml \
  --dataset eval/dataset.jsonl --graders eval/graders.yaml --concurrency 1
```

## 7 — Close the loop with the flywheel

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

## 8 — On a schedule (the daemon)

The same expert — same domain, same curriculum, same exam, its own wiki
space — also runs as an always-on daemon.
[`daemon.yaml`](../starters/expert/daemon.yaml) (`target: channel`)
adds a **heartbeat** that fires every 6h — and because the spec declares
`learning:`, the built-in **`learning.study.on_heartbeat` rotation** (default
on) is baked ahead of the operator's tick instructions at compile time: gaps
first, otherwise ~3 STUDY : 1 REFLECT, bounded per tick.
[`HEARTBEAT.md`](../starters/expert/HEARTBEAT.md) *documents* the policy;
nothing re-implements it at runtime.

```yaml
heartbeat:
  every: 6h
  instructions: |
    Do the pass the rotation selects, then log a one-line result. If there
    is genuinely nothing useful to do this tick, log `heartbeat: idle`.
```

That's the "regularly reads sources / reflects on its own" cadence: it
answers in Slack, studies and reflects on a timer, and turns reactions into
training signal — a domain expert that is awake, improving, and accountable
to an exam even when nobody's asking.

*Wiki backend note:* the daemon is on Thredz too — `thredz:` has been
emit-wired on the channel shape since CrewHaus 0.4.0 — but on its **own**
key (`$THREDZ_DAEMON_KEY`) and its own space (`coffee-daemon`), for the
reason in §1: one individual space per key. What it studies unattended is
its memory, and the interactive expert's key cannot read it. That's a
choice, not a constraint — the two ways to make them one brain are in §1,
and [Recipe 73](73-trading-advisor.md) takes the sharing branch. Deleting
the `thredz:` block goes the other way entirely: the `memory.wiki` block
underneath takes over and the daemon runs on local files under
`.crewhaus/wiki/`, the backend where the `## Sources` gate is code (§4).

## Run it

```bash
cd starters/expert
cp .env.example .env       # THREDZ_API_KEY (+ wiki grant + its coffee-expert space), ANTHROPIC_API_KEY, search keys
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
  `curriculum.md`'s ladder and `learning.sources` first.
- **You don't want a hosted backend.** That's not a blocker anymore — swap
  the `thredz:` block for `memory.wiki: { enabled: true, autoRecall: true }`
  and the same skill, tools, and exam run against local files under
  `.crewhaus/wiki/`. (It's also the answer on Free and Starter plans, which
  have no spaces.) Use Thredz when you want the wiki hosted, shared across
  machines, or visible to other agents you own.

## Pointers to source

- **Composition root (wires all of it):** [`packages/memory-service`](https://github.com/crewhaus/factory/tree/main/packages/memory-service).
- **Wiki substrate + tool vocabulary:** [`packages/wiki-store`](https://github.com/crewhaus/factory/tree/main/packages/wiki-store), [`packages/tool-wiki`](https://github.com/crewhaus/factory/tree/main/packages/tool-wiki).
- **The `learning-loop` skill + `/study` `/reflect` `/exam`:** [`packages/default-skills`](https://github.com/crewhaus/factory/tree/main/packages/default-skills).
- **Exam runner + judge rubric:** [`packages/eval-runner`](https://github.com/crewhaus/factory/tree/main/packages/eval-runner), [`packages/eval-judge`](https://github.com/crewhaus/factory/tree/main/packages/eval-judge).
- **Heartbeat study rotation:** [`packages/target-channel-bot`](https://github.com/crewhaus/factory/tree/main/packages/target-channel-bot).
- **Flywheel:** [`packages/eval-optimizer-orchestrator`](https://github.com/crewhaus/factory/tree/main/packages/eval-optimizer-orchestrator).
- **Thredz wiki API:** [thredz.crewhaus.ai](https://thredz.crewhaus.ai).
