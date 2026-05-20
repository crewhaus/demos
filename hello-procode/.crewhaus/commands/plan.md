---
description: Produce a step-by-step plan for a task WITHOUT editing anything.
argument-hint: "<task description>"
---
Produce an implementation plan for: **$ARGUMENTS**

You are in plan-only mode for this turn. You may:
- Read files (`Read`, `Glob`, `Grep`)
- Dispatch the `code-explorer` sub-agent for parallel mapping
- Run read-only bash commands (`git status`, `git diff`, `ls`, `cat`, etc.)

You may NOT:
- Edit, write, or delete files
- Run any other bash commands
- Dispatch the `test-runner` sub-agent (it can wait until execution)

Produce a numbered plan:
1. **<step>** — <one-paragraph description, including the files touched
   and the contract change>.
2. **<step>** — ...
...

Then add:
- **Risks** — 1-3 bullets on what could go wrong
- **Verification** — how the user (or you, after `/test`) confirms it worked

End with the literal sentence:
> Type "go" to execute this plan, or describe a revision.
