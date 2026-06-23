---
description: Resume an active GOAL-mode condition from GOAL.md.
argument-hint: ""
---
Resume GOAL mode.

1. Read `GOAL.md` at the repo root.
   - If it does not exist or has no `## Condition`, say "No active goal."
     and stop.
2. Restate the active condition and the last Progress entry in 2 lines.
3. Re-enter GOAL mode (see the `# Goal mode` section of your
   instructions): work one increment, dispatch the `verifier`, append the
   verdict, and either continue or print `GOAL MET:` and exit.

$ARGUMENTS may narrow what to work on next; otherwise pick up the
verifier's last `NEXT:` step.
