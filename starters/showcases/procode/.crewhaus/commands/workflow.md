---
description: Orchestrate a one-off multi-agent workflow (fan-out) for a task.
argument-hint: "<goal to fan out>"
---
Run a multi-agent workflow for: **$ARGUMENTS**

1. Load the `orchestration` skill for fan-out patterns.
2. Dispatch the `orchestrator` sub-agent via `Task` with the goal
   `$ARGUMENTS`. It will DECOMPOSE the goal, FAN OUT specialist
   sub-agents in parallel, CROSS-CHECK their returns, and SYNTHESIZE one
   merged result.
   - For a small fan-out (2-3 independent angles) you may dispatch the
     workers yourself in one turn instead of going through the
     orchestrator.
3. Record the sub-task plan with `todoWrite`.
4. When the orchestrator returns, present:
   - the sub-task plan (who did what),
   - merged findings ranked by severity, attributed per agent,
   - one recommended next action.

Do NOT edit during the workflow unless `$ARGUMENTS` explicitly asks to
apply changes — a workflow is for analysis + planning by default.
