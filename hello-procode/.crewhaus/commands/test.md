---
description: Run the project's tests via the test-runner sub-agent.
argument-hint: "[extra-args]"
---
Dispatch the `test-runner` sub-agent via `Task` with the input:

  "Run the project's tests. Extra args: $ARGUMENTS"

After the sub-agent returns, summarise in 2-3 lines:
- Pass / fail count
- First failure's file:line (if any)
- One concrete next step the user could take

If the sub-agent reports it could not detect a test command, suggest the
user document the test command by running `/init` (which will record it
in CODE-COMPANION.md for future sessions).
