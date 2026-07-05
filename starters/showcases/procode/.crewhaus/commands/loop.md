---
description: Enter GOAL mode — work autonomously toward a verifiable condition.
argument-hint: "<completion condition>"
---
Enter GOAL mode with the completion condition: **$ARGUMENTS**

1. Write `GOAL.md` at the repo root:

   ```
   # GOAL.md

   Set by hello-procode /loop on <today's date>.

   ## Condition
   $ARGUMENTS

   ## Progress
   - <turn 1>: <what you did, verifier verdict>
   ```

   Phrase the condition as something the `verifier` can CHECK (e.g.
   "the full test suite passes AND `npm run typecheck` is clean").

2. Work ONE increment toward the condition this turn. Use `todoWrite` to
   track remaining work.

3. Dispatch the `verifier` sub-agent via `Task`. It returns
   `VERDICT: YES|NO`, a reason, and the next step.

4. Append the verdict to `GOAL.md` § Progress. Then:
   - `VERDICT: NO` — state the next step and KEEP GOING next turn. The
     goal stays active.
   - `VERDICT: YES` — print `GOAL MET:` + the condition, clear the
     Progress section, and exit GOAL mode.

> Note: state lives in `GOAL.md` on disk, so the goal outlives the
> conversation context — re-read it (or run `/resume-goal`) to recover
> after compaction or in a new session. The session itself also resumes:
> `crewhaus run crewhaus.yaml --continue` reopens this exact
> conversation. For low-friction unattended iteration, launch with
> `crewhaus run --permission-mode auto` (reads auto-allowed, destructive
> still asks) and consider the spec's optional `budget:` spend cap.
