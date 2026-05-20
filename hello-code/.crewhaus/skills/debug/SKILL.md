---
name: debug
description: |
  Structured debugging playbook. Use when the user reports something is
  broken, throws an error, or behaves unexpectedly. Walks Reproduce →
  Isolate → Diagnose → Fix → Verify.
triggers:
  - "debug"
  - "broken"
  - "not working"
  - "throws"
  - "error"
  - "stack trace"
  - "why does this fail"
---

# debug — structured bug-fix playbook

## 1. Reproduce

- Get the exact command, input, or sequence that triggers the failure.
  If the user only described it, ask for the literal trigger.
- Try to reproduce locally before reading any code. A bug you can't
  reproduce is a bug you can't verify you fixed.

## 2. Isolate

- Bisect: comment out / disable code paths until the failure goes away.
  The last block you removed is suspect.
- For regressions: `git bisect` or `git log -p <file>` on the file
  involved in the stack trace.
- Distinguish between *symptoms* (what the user sees) and *cause*
  (what's wrong upstream).

## 3. Diagnose

- Read the failing code top-to-bottom in the file where the failure
  surfaces. Do NOT skip to the line in the stack trace — the bug is
  often a few lines earlier (uninitialized state, missing guard,
  wrong assumption).
- Cross-check the data: log or print the actual values, don't trust
  what the code "should" be doing.
- Name the root cause in one sentence before writing a fix.

## 4. Fix

- Smallest possible change that fixes the root cause. No drive-by
  refactoring inside the bug fix.
- If the fix touches > 1 file or > 20 lines, switch to `/plan` mode.

## 5. Verify

- Re-run the original reproducer. The failure must be gone.
- If a test exists for this code path, run it. If not, write one — the
  next regression here should be caught automatically.
- Dispatch the `test-runner` sub-agent for the full suite to catch
  collateral damage.

## Anti-patterns to avoid

- "Fixing" by adding a try/except that swallows the error.
- "Fixing" by adding a special case for the failing input without
  understanding why the general case doesn't handle it.
- Declaring victory without re-running the reproducer.
