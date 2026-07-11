# Heartbeat playbook (daemon.yaml)

The `daemon.yaml` heartbeat fires on a schedule and sends a synthetic tick.
This file is the playbook it reads each tick. It rotates the expert through
STUDY and REFLECT so it improves on a cadence, unattended.

## Which pass to run this tick

Rotate to balance learning against consolidation:

1. Check for open **knowledge gaps** (recall your `knowledge-gap` tasks /
   search the wiki). If any exist → **STUDY**, targeting the highest-priority
   gap. Closing measured gaps always wins.
2. Otherwise, roughly **3 STUDY ticks : 1 REFLECT tick**. Track the count in
   a durable note (`Remember`) or infer it from recent wiki activity: if the
   last few ticks were all STUDY, run **REFLECT** now.
3. If a STUDY pass has nothing new to add (ladder rung already covered, no
   fresh sources) → run **REFLECT** instead, or log `heartbeat: idle`.

Keep each tick BOUNDED — one topic studied, or a handful of articles
reflected on. It's a heartbeat, not a marathon; the next tick continues.

## STUDY tick

1. Pick the topic (gaps → next `curriculum.md` rung → frontier). Read
   `curriculum.md`.
2. Dispatch 2-3 `researcher` sub-agents in ONE turn, each on a narrow
   sub-question, against the source allowlist. Synthesise their snippets.
3. Separate time-tested from frontier knowledge. Commit durable, high-value
   knowledge with `thredz__wiki_write` — stable slug, `## Sources` section,
   tags, honest `confidenceScore`. Upsert; refine, don't duplicate.
4. Log a one-line result: `heartbeat: study <slug> (conf 0.x)`.

## REFLECT tick

1. `thredz__wiki_list` sort=updated order=asc → the stalest articles; also
   scan for the lowest `confidenceScore`.
2. For a few of them: `thredz__wiki_related` → find contradictions /
   duplicates → reconcile (merge, correct, supersede). Re-verify shaky
   claims against a primary source.
3. `thredz__wiki_set_signals`: mark re-verified articles `verified: true`;
   adjust `confidenceScore` to match reality.
4. Curate the plan and the exam:
   - `Edit curriculum.md` — tick mastered rungs, add rungs for recurring gaps.
   - `Edit eval/dataset.jsonl` — add questions for newly-mastered topics;
     never delete a question you merely failed.
5. Log a one-line result: `heartbeat: reflect (N reconciled, M re-verified)`.

## Guardrails
- No source, no wiki commit.
- Don't commit ephemera (today's news, opinions) — only knowledge that will
  still be true and useful later.
- If unsure whether a claim is right, lower its `confidenceScore` and flag it
  for the next REFLECT rather than asserting it.
