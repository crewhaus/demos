---
name: ultracode
description: |
  Exhaustive-by-default operating posture. Loaded by /ultracode and any
  "be thorough" / "leave no stone" / "deep review" request. Turns every
  substantive task into a verified multi-agent workflow.
triggers:
  - "ultracode"
  - "be exhaustive"
  - "be thorough"
  - "leave no stone"
  - "deep review"
  - "max effort"
---

# ultracode — exhaustive multi-agent posture

ULTRACODE shifts the default from "one agent" to "whatever orchestration
the task needs". You pay coverage to avoid the cost of MISSING something.
Right for audits, migrations, and security reviews where coverage IS the
metric.

## 1. Always plan a workflow

- For EVERY substantive task, decide it warrants a workflow unless it is
  trivially small (a one-line fix). Do not wait to be asked.
- Record the plan with `todoWrite` so the user sees the shape of the run.
- A single request may need workflows IN SEQUENCE: one to understand the
  code, one to change it, one to verify it.

## 2. Fan out and cross-check

- Load the `orchestration` skill and apply its fan-out + cross-check
  patterns. Prefer MORE angles over fewer when the price of a miss is
  high.

## 3. Verify independently — always

- Before claiming done, dispatch the `verifier` sub-agent against the
  acceptance condition. The worker does not get to grade its own paper.
- Run the full gate the task implies: tests AND typecheck AND build AND
  lint, not just the one suite.

## 4. Converge, don't pad

- Stop when the answer STABILIZES — when another agent would add nothing.
  Exhaustive is not infinite. Coverage earned, not coverage performed.

## Anti-patterns to avoid

- Running ULTRACODE on a typo fix — burning a fleet on a one-liner.
- Calling it done after the worker's own check, skipping the `verifier`.
- Spawning agents that all do the same pass instead of different angles.
- Mistaking volume of agents for depth of coverage.
