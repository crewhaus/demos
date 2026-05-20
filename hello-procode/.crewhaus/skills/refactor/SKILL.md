---
name: refactor
description: |
  Safe-refactor playbook. Behavior-preserving change with verification.
  Loaded by "refactor", "clean up", "extract", "rename", etc.
triggers:
  - "refactor"
  - "clean up"
  - "tidy"
  - "extract"
  - "rename"
  - "DRY this"
---

# refactor — safe-refactor playbook

## Safety contract

A refactor MUST:
- Preserve external behavior. Same inputs → same outputs, same side
  effects, same error semantics.
- Have a green test suite both BEFORE and AFTER the change. If there
  are no tests for the code you're refactoring, write a characterization
  test first.
- Be a single concern per commit. "Rename + extract + change signature"
  is three commits, not one.

## Workflow

1. **Verify green start**
   - Dispatch `test-runner` to run the suite. Note the baseline.
   - If tests don't cover the code you're changing, write a
     characterization test that locks in current behavior. Run it.
     It must pass on the unchanged code.

2. **Make the change**
   - Smallest possible mechanical transform. If you want to also
     change behavior, that's a separate commit AFTER this one.
   - Common safe refactors:
     - **Extract function/method**: pure mechanical, no signature change
     - **Rename**: use the LSP / IDE renamer if available; otherwise
       grep for every reference (including strings, since not all
       languages have type-safe references)
     - **Inline**: paste the body, delete the function — only if it's
       used in ≤ 3 places
     - **Move / split file**: update all imports

3. **Verify green end**
   - Re-run the test suite via `test-runner`. Same pass count.
   - If a test fails that didn't before, you broke behavior. Revert
     and try a smaller step.

4. **Commit and stop**
   - One refactor, one commit, one clear message. Don't sneak unrelated
     changes in.

## Anti-patterns to avoid

- "Refactoring" while fixing a bug. Do the fix, then refactor in a
  separate change. Otherwise the diff becomes unreviewable.
- Refactoring without tests. The whole safety contract collapses.
- "Renaming" by deleting all references and inserting new ones. Use
  the renamer or grep — silently dropping a reference is a bug, not
  a refactor.
- Refactoring code you don't plan to touch again. The cost-benefit
  curve says no. Refactor what you're about to extend.
