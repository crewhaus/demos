---
description: Run an independent verification pass on the current work.
argument-hint: "[condition, default: GOAL.md or 'tests pass']"
---
Independently verify the current state of the work.

1. Determine the condition:
   - If `$ARGUMENTS` is non-empty, use it as the acceptance condition.
   - Else if `GOAL.md` exists, use its `## Condition`.
   - Else default to "the full test suite passes with no new failures".

2. Dispatch the `verifier` sub-agent via `Task` with that condition. The
   verifier did NOT do the work — it judges cold by running the
   test/typecheck/build/lint commands the condition names.

3. Relay the verifier's verdict verbatim:
   ```
   VERDICT: YES | NO
   REASON: <one line>
   NEXT:   <next step or —>
   ```

Do NOT edit in this command — it is verification-only. If the verdict is
NO, the user runs a normal turn (or `/loop`) to act on `NEXT:`.
