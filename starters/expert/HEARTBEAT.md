# Heartbeat — how the daemon studies unattended

Since v0.3.0 the study rotation is **built in**. `daemon.yaml` declares a
`learning:` block, and `learning.study.on_heartbeat` (default on) makes the
compiler prepend the study-rotation preamble to every heartbeat tick's
instructions. This file *documents* the policy; nothing reads it at runtime
anymore.

## The built-in rotation (what each tick does)

1. **Gaps first.** The tick lists open knowledge gaps (`GoalList` on a
   local wiki; `task_list` tagged `knowledge-gap` on Thredz). Any open gap
   makes this a STUDY tick aimed at the top gap — closing measured blind
   spots always wins.
2. **Otherwise ~3 STUDY : 1 REFLECT.** STUDY works the next unmastered rung
   of `curriculum.md`, then the frontier; REFLECT reconciles stale and
   low-confidence articles. The mix is inferred from recent wiki activity —
   no ad-hoc counters.
3. **Bounded.** One topic studied, or a handful of articles reconciled,
   per tick — commit cited wiki writes, summarize in one line, stop. It is
   a heartbeat, not a marathon; the next tick continues.

The passes themselves (STUDY's gather-cite-commit discipline, REFLECT's
supersede-never-delete reconciliation) come from the shipped
`learning-loop` skill — run `/study` or `/reflect` in the cli harness to
drive the same passes interactively.

## Guardrails (enforced, not asked)

- **No source, no commit** — on this daemon's **local** `memory.wiki`
  backend, `wiki_write` *rejects* a body without a `## Sources` section:
  with `learning:` on, the tool layer enforces it deterministically, so
  what used to be prompt discipline is a hard gate. (On the hosted
  `thredz:` backend — what the cli spec uses — the same rule lives in the
  `learning-loop` skill's instructions, not the tool layer.)
- Wiki writes and signal changes are justification-gated and audited.
- Don't commit ephemera (today's news, opinions) — only knowledge that will
  still be true and useful later.

## Tuning

- Cadence: `heartbeat.every` in `daemon.yaml` (`"5m"` for a live demo,
  `"6h"` for production).
- Opt out of unattended study while keeping the heartbeat:
  `learning: { study: { on_heartbeat: false } }`.
- Your own per-tick instructions in `heartbeat.instructions` run *after*
  the rotation preamble — the operator always gets the last word.
