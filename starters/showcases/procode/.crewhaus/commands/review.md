---
description: Review uncommitted changes (or a given diff) for security, correctness, and style.
argument-hint: "[diff-spec, default: HEAD]"
---
Review the code changes implied by `$ARGUMENTS` (default: `HEAD` — i.e.
all uncommitted changes since the last commit).

1. Run the appropriate `git diff` command:
   - If `$ARGUMENTS` is empty, run `git diff HEAD`.
   - If `$ARGUMENTS` looks like a commit SHA or branch, run
     `git diff $ARGUMENTS`.
   - If `$ARGUMENTS` is a file path, run `git diff -- $ARGUMENTS`.

2. Load the `code-review` skill (it has the security / correctness /
   performance / style checklist).

2b. In ULTRACODE mode, instead of reviewing solo, dispatch the
   `reviewer` AND `security-auditor` sub-agents in parallel on this diff
   (one turn, two `Task` calls) and merge their findings before the hunk
   walk below.

3. Walk the diff hunk by hunk. For each hunk, emit either:
   - `✓ <hunk header>: looks good` — no concerns, OR
   - `⚠ <hunk header>:<line>` followed by 1-3 lines explaining the concern
     and suggesting a fix.

4. End with a verdict line:
   - `Verdict: ship it` — no concerns
   - `Verdict: minor` — only style/nit concerns
   - `Verdict: needs changes` — at least one correctness/security concern

Do NOT edit anything. This is a review-only command — the user runs `/plan`
or asks for changes in a normal turn if they want edits.
