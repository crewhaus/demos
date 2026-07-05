---
description: Switch to ULTRACODE mode — exhaustive multi-agent orchestration by default.
argument-hint: "[optional first task]"
---
Enter ULTRACODE mode for the rest of this session.

From now until the user runs `/standard`, treat EVERY substantive task as
a workflow:
- DECOMPOSE the task into independent sub-tasks.
- FAN OUT specialist sub-agents via `Task`, emitting ALL the calls in one
  turn (every result returns together): `code-explorer`, `reviewer`,
  `security-auditor`, `debugger`, `test-runner`, `docs-writer`. Read-only
  workers (`code-explorer`) run concurrently; command/write workers run
  serially — so parallelize by fanning out the read-only mapping work.
- CROSS-CHECK conflicting returns instead of averaging them.
- VERIFY with the independent `verifier` sub-agent BEFORE claiming done.
- Record the plan with `todoWrite` so progress stays visible.

You decide WHEN a task warrants a full fan-out — audits, migrations, and
security reviews ALWAYS do; a one-line fix does not. Spend coverage, not
speed.

Confirm with: `ULTRACODE on.` then, if `$ARGUMENTS` is non-empty, begin
that task as a workflow immediately. Otherwise wait for the next request.

> Note: this sets the agent's BEHAVIORAL posture — coverage comes from
> orchestration, not from a bigger single brain. The spec-side depth
> lever is `agent.max_tokens` (this harness raises it to 16384; the
> runtime default is 8192).
