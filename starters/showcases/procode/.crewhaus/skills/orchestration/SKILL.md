---
name: orchestration
description: |
  Multi-agent workflow patterns: fan-out parallelization, adversarial
  review, judge panels, and synthesis. Loaded by /workflow, /ultracode,
  and any "orchestrate" / "fan out" / "many agents" request.
triggers:
  - "workflow"
  - "orchestrate"
  - "fan out"
  - "parallel agents"
  - "multi-agent"
  - "audit the whole"
---

# orchestration — multi-agent workflow patterns

A workflow moves orchestration OUT of one conversation and into a
decompose → dispatch → synthesize loop. Use it when one agent cannot hold
the whole task: audits, large migrations, security reviews, multi-angle
research.

## 1. Decompose

- Split the goal into 3-8 INDEPENDENT sub-tasks. Independent means they
  can run without reading each other's output. Overlap is waste.
- Size each sub-task to one specialist's job: map / review / audit /
  debug / test / document / verify.

## 2. Fan out (parallel dispatch)

- Emit MULTIPLE `Task` calls in ONE turn. The runtime runs read-only,
  concurrency-safe dispatches in parallel — serial dispatch throws away
  the wall-clock win.
- Match each sub-task to the right worker: `code-explorer`, `reviewer`,
  `security-auditor`, `debugger`, `test-runner`, `docs-writer`,
  `verifier`. Read-only workers run on cheaper models — that is by
  design, not a compromise.
- For large/high-stakes fan-outs, dispatch the `orchestrator` sub-agent
  to plan and drive the whole thing and hand you back one merged result.

## 3. Cross-check (quality patterns)

- **Adversarial review**: have one agent produce, a DIFFERENT agent
  attack. The `verifier` exists for exactly this.
- **Judge panel**: on a contentious finding, dispatch 2-3 reviewers and
  take the majority. Disagreement is signal — surface it, don't bury it.
- **Diversity of approaches**: for a hard design choice, ask two agents
  for two solutions, then compare trade-offs.

## 4. Synthesize

- Merge returns into ONE ranked answer. Attribute each finding to the
  agent that produced it — provenance lets the user trust or challenge it.
- When two returns conflict, re-dispatch with the conflict as input.
  NEVER silently pick one.

## Anti-patterns to avoid

- Fanning out sub-tasks that depend on each other — they serialize
  anyway and you pay for the agents twice.
- Dispatching agents serially when they are independent. One turn, many
  `Task` calls.
- Letting the agent that did the work also declare it done. Always route
  the final judgment through the independent `verifier`.
- Averaging conflicting findings into mush instead of resolving the
  conflict.
