---
name: goal-decomposition
description: |
  Turning a fuzzy goal into a verifiable completion condition and an
  iterate-until-done loop. Loaded by /loop, /resume-goal, and any "keep
  going until" / "work the backlog" request.
triggers:
  - "until it passes"
  - "keep going until"
  - "work the backlog"
  - "goal"
  - "loop until"
  - "iterate until done"
---

# goal-decomposition — verifiable goals + iterate-until-done

GOAL mode removes per-turn prompting for iterative work. The key is a
condition a SEPARATE evaluator can check, so you cannot declare yourself
done early.

## 1. Make the condition verifiable

- Rewrite a fuzzy goal ("make it work") into a checkable one ("all tests
  pass AND `npm run typecheck` is clean AND the new endpoint returns
  200"). If you cannot name the check, you cannot loop on it — ask the
  user for the acceptance criteria first.
- Write it to `GOAL.md` at the repo root. That file lives on disk, so it
  outlives the conversation context — it is the durable scratchpad that
  survives compaction and `/resume-goal`.

## 2. Increment, then evaluate

- Do ONE meaningful increment per turn. Track remaining work with
  `todoWrite`.
- Dispatch the `verifier` sub-agent — an INDEPENDENT agent — to return
  `VERDICT: YES|NO`, a reason, and the single best next step.

## 3. Loop on NO, exit on YES

- `NO`: append the verdict to `GOAL.md` § Progress, take the verifier's
  `NEXT:` step next turn. Keep the goal active.
- `YES`: print `GOAL MET:` + the condition, clear Progress, exit GOAL
  mode.

## 4. Survive interruption

- Because state lives in `GOAL.md` on disk, `/resume-goal` re-reads it and
  picks the loop back up in a fresh session — even after the in-context
  copy is compacted away. Always keep `GOAL.md` current — it is the only
  memory that crosses the turn boundary.

## Anti-patterns to avoid

- A condition only the working agent can judge ("looks good to me"). Use
  a command-checkable condition and the `verifier`.
- Doing the whole goal in one turn instead of increment-then-check —
  you lose the independent gate.
- Letting `GOAL.md` go stale, then resuming into the wrong state.
- Declaring `GOAL MET` without the verifier returning `VERDICT: YES`.
