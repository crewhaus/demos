# Heartbeat — how the daemon studies unattended

Since v0.3.0 the study rotation is **built in**. `daemon.yaml` declares a
`learning:` block, and `learning.study.on_heartbeat` (default on) makes the
compiler prepend the study-rotation preamble to every heartbeat tick's
instructions. This file *documents* the policy; nothing reads it at runtime
anymore.

## The built-in rotation (what each tick does)

1. **Gaps first.** The tick lists open knowledge gaps — `task_list` tagged
   `knowledge-gap` on this daemon's Thredz backend (`GoalList` if you drop
   `thredz:` and fall back to the local wiki). Any open gap makes this a
   STUDY tick aimed at the top gap — closing measured blind spots always
   wins.
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

- **One space is the blast radius.** The daemon runs on its own key
  (`$THREDZ_DAEMON_KEY`) and writes only into its own space
  (`coffee-daemon`). A study pass nobody is watching cannot reach the
  interactive expert's `coffee-expert` space — that is what one individual
  space per API key buys you, and why the two specs don't share a key.
- **No source, no commit** — on the hosted `thredz:` backend this daemon
  uses, that rule lives in the `learning-loop` skill's instructions. On a
  **local** `memory.wiki` backend it is a hard gate instead: with
  `learning:` on, the tool layer *rejects* a `wiki_write` body that has no
  `## Sources` section. Delete the `thredz:` block from `daemon.yaml` to
  fall back to local files and watch the mechanical rejection.
- Wiki writes and signal changes are justification-gated and audited —
  including `wiki_space_create`, which consumes plan quota.
- Don't commit ephemera (today's news, opinions) — only knowledge that will
  still be true and useful later.

## Tuning

- Cadence: `heartbeat.every` in `daemon.yaml` (`"5m"` for a live demo,
  `"6h"` for production).
- Where the writes land: `thredz.space` in `daemon.yaml`. Point it at the
  same **shared** space as the cli spec and the two shapes become one brain
  — the overnight study then shows up in the interactive expert's recall.
- Opt out of unattended study while keeping the heartbeat:
  `learning: { study: { on_heartbeat: false } }`.
- Your own per-tick instructions in `heartbeat.instructions` run *after*
  the rotation preamble — the operator always gets the last word.
