---
description: Switch to ULTRACODE mode — exhaustive multi-agent orchestration by default.
argument-hint: "[optional first task]"
---
Enter ULTRACODE mode for the rest of this session.

From now until the user runs `/standard`, treat EVERY substantive task as
a workflow:
- DECOMPOSE the task into independent sub-tasks.
- FAN OUT specialist sub-agents IN PARALLEL via `Task` (emit the calls in
  one turn so read-only ones run concurrently): `code-explorer`,
  `reviewer`, `security-auditor`, `debugger`, `test-runner`,
  `docs-writer`.
- CROSS-CHECK conflicting returns instead of averaging them.
- VERIFY with the independent `verifier` sub-agent BEFORE claiming done.
- Record the plan with `todoWrite` so progress stays visible.

You decide WHEN a task warrants a full fan-out — audits, migrations, and
security reviews ALWAYS do; a one-line fix does not. Spend coverage, not
speed.

Confirm with: `ULTRACODE on.` then, if `$ARGUMENTS` is non-empty, begin
that task as a workflow immediately. Otherwise wait for the next request.

> Note: this sets the agent's BEHAVIORAL posture. For the deepest
> REASONING budget, also launch with `crewhaus run --effort xhigh` (the
> runtime effort lever — it is not a spec field).
