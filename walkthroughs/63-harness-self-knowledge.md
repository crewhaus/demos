# Recipe 63 — The harness learns from its own history

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `session-persistence`, `fewshot` (#54), `faq` (#55), `lessons` (#56), `sessions-index` (#57), `pii-redactor`.
**Shipped:** crewhaus 0.2.0 (`fewshot harvest`/`show`, `faq distill`, `lessons update`, `sessions summarize`, `optimize --few-shot`, `run --user`).

[Recipe 57 — The advisor loop](57-advisor-loop.md) mines session history into
*spec patches* you apply through an eval gate. This recipe covers the other
half of learning-from-history: four commands that turn what already happened
into **reusable knowledge the harness loads on its own** — a golden few-shot
pool, an auto-discovered FAQ skill, an auto-loaded `LESSONS.md`, and a durable
session index. None of them touch your spec; they build artifacts the runtime
(or the optimizer) picks up next run.

They all read the same source — sessions under `.crewhaus/sessions/`, weighted
by the ratings from [Recipe 62 — Response Ratings](62-response-ratings.md) — so
they're only as good as the traffic and feedback you've accumulated.

You'd reach for these when:

- Your agent answers a recurring question well **once** and you want that
  answer to become a reusable example or a first-class FAQ.
- Users keep **correcting** the agent the same way and you want those
  corrections to stick without hand-editing the prompt.
- You're about to lose session history to a retention TTL and want a
  **durable summary** before it's evicted.

## Prerequisites

- [Recipe 62 — Response Ratings](62-response-ratings.md). Three of these four
  commands rank turns by rating (`--min-score` / `--low-score`); a harness with
  no ratings still works but has weaker signal.
- Some real sessions on disk under `.crewhaus/sessions/`. Like the advisor,
  these are history miners — they have nothing to say about a harness that's
  never run.

## `fewshot harvest` — a golden few-shot pool from what worked

`fewshot harvest` collects your **up-rated** turns into a golden few-shot pool,
PII- and secret-redacted on the way in. `fewshot show` prints the pool as the
prompt block it will be injected as:

```bash
crewhaus fewshot harvest --all-sessions --min-score 0.8   # → .crewhaus/fewshot/pool.jsonl
crewhaus fewshot show --k 5                                # print the top-K as an injectable block
```

The pool is consumed at optimize time, not baked into the spec:

```bash
# `auto` resolves the harvested pool; or pass an explicit pool path.
crewhaus optimize crewhaus.yaml --few-shot auto --few-shot-k 5 --write-back \
  --dataset registry:support-agent-ratings --graders graders.yaml
```

`optimize --few-shot` is **patch-only** — it injects the top-K examples as
in-context demonstrations and gates the result on the eval like any other
candidate, so a pool that doesn't actually help is rejected. The examples are
redacted at harvest, never at inject, so nothing sensitive is re-read.

## `faq distill` — recurring questions become a first-class skill

`faq distill` clusters questions that recur across sessions and drafts an
**auto-discovered FAQ skill** — a `SKILL.md` the harness can load like any other
skill:

```bash
crewhaus faq distill --sessions all --min-occurrences 3 --min-score 0.7 \
  -o skills/faq
```

`--min-occurrences` is the noise floor — a question has to come up at least that
many times to earn an entry, so one-off asks don't bloat the skill. The output
is a review surface: read the drafted `skills/faq/SKILL.md`, prune it, and wire
it into `skills:` when you're happy with it.

## `lessons update` — corrections that stick

`lessons update` mines **corrections and failures** into an auto-loaded
`LESSONS.md`, plus per-user preference files under `.crewhaus/preferences/`:

```bash
crewhaus lessons update --sessions all --low-score 0.4   # → LESSONS.md + .crewhaus/preferences/<user>.md
```

The merge is append-with-dedupe and **idempotent** — a re-run over the same
history produces a byte-identical `LESSONS.md`, and a hand-written preamble above
the merge marker is preserved. `LESSONS.md` is auto-loaded at run start; the
per-user preferences are injected when you name the user:

```bash
crewhaus run crewhaus.yaml --user max   # injects .crewhaus/preferences/max.md + LESSONS.md
```

That's the loop closing without a spec edit: a user corrects the agent, the
correction lands in `LESSONS.md` / their preference file, and the next run reads
it back.

## `sessions summarize` — a durable index before the TTL evicts

Retention ([Recipe 22 — Compliance & Audit](22-compliance-and-audit.md)) expires
raw sessions on a schedule. `sessions summarize` distills them into a durable
index first, so the *lessons* survive even when the transcripts don't:

```bash
crewhaus sessions summarize --before 2026-06-01     # index sessions older than a date
crewhaus sessions summarize --evicted --ttl-days 30 # index each session just before it's deleted
```

Wire the `--evicted` form alongside `retention sweep` and the summary is written
in the same pass that would otherwise drop the session — the index outlives the
TTL.

## What each command writes

| Command                    | Reads                         | Writes                                              |
| -------------------------- | ----------------------------- | --------------------------------------------------- |
| `fewshot harvest`          | up-rated turns                | `.crewhaus/fewshot/pool.jsonl` (redacted)           |
| `fewshot show`             | the pool                      | nothing — prints the injectable block               |
| `faq distill`              | recurring questions           | `<skill-dir>/SKILL.md` (review, then wire into `skills:`) |
| `lessons update`           | corrections + failures        | `LESSONS.md` + `.crewhaus/preferences/<user>.md`    |
| `sessions summarize`       | sessions (pre-eviction)       | a durable session index under `.crewhaus/`          |

## When to NOT reach for these

- **On a harness with no traffic or no ratings.** All four are history miners;
  three of them rank by rating. Run [Recipe 62](62-response-ratings.md) first.
- **To change the spec.** These build *artifacts* (a pool, a skill, a
  `LESSONS.md`, an index). For eval-gated spec suggestions, that's the advisor —
  [Recipe 57](57-advisor-loop.md).
- **To auto-apply anything unattended.** `faq distill` and `lessons update`
  produce review surfaces; look before you wire them into `skills:` or trust the
  merged lessons.

## What to read next

- **The ratings that weight all of this.** [Recipe 62 — Response Ratings](62-response-ratings.md).
- **The spec-patch half of learning-from-history.** [Recipe 57 — The advisor loop](57-advisor-loop.md).
- **The retention TTL `sessions summarize` races.** [Recipe 22 — Compliance & Audit](22-compliance-and-audit.md).

## Pointers to source

- **Few-shot harvest / inject:** [`apps/cli/src/fewshot.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/fewshot.ts).
- **FAQ distill:** [`apps/cli/src/faq.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/faq.ts).
- **Lessons + preferences:** [`apps/cli/src/lessons.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/lessons.ts).
- **Session index:** [`apps/cli/src/sessions-index.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/sessions-index.ts).
- **Redaction on harvest:** [`packages/pii-redactor`](https://github.com/crewhaus/factory/blob/main/packages/pii-redactor).
