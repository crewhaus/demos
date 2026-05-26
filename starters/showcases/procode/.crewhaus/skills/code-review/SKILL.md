---
name: code-review
description: |
  Security + correctness + performance + style checklist for reviewing a
  diff. Loaded by /review and any "review this" / "is this safe" request.
triggers:
  - "review"
  - "is this safe"
  - "code review"
  - "look this over"
  - "any issues with"
---

# code-review — diff review checklist

Walk every diff hunk through four passes, in this order:

## 1. Security (OWASP-aligned)

- **Injection**: SQL string concatenation, shell exec with user input,
  HTML rendering of unescaped data, eval/Function() on untrusted strings.
- **AuthN/AuthZ**: missing auth checks on new endpoints, broken
  ownership checks (`user.id == resource.owner_id`), tokens in logs
  or URLs.
- **Secrets**: hardcoded API keys, .env values committed, secrets in
  error messages.
- **Crypto**: rolling your own (don't), `Math.random()` for security,
  unsalted password hashes, missing HMAC verification on webhooks.
- **SSRF/Path traversal**: user-controlled URLs in fetch, user-
  controlled paths in fs.read.

## 2. Correctness

- **Null / undefined / empty**: every value pulled from external
  sources (DB, API, user input) is potentially missing.
- **Error paths**: every async/await + try/catch — does the catch
  actually handle it, or just log and continue?
- **Off-by-one**: loop bounds, slice indices, `>=` vs `>`.
- **Concurrency**: shared state without locks, race conditions in
  initialization, double-await of the same promise.
- **Edge cases**: empty arrays, single-element arrays, very long
  strings, zero, negative numbers, NaN, Infinity.

## 3. Performance

- **N+1 queries**: a loop with a query inside it. ORM lazy-load is the
  most common offender.
- **Blocking I/O in async handlers**: `fs.readFileSync` in an
  endpoint, `JSON.parse` on multi-MB strings.
- **Memory**: loading whole files / DB result sets when streaming is
  trivial.
- **Cache invalidation**: a write that doesn't bust a cached read.

## 4. Style

- Naming: does the variable describe the value, or the type?
- Comments: are they explaining *what* (delete) or *why* (keep)?
- Tests: every behavioral change has a test, every bugfix has a
  regression test.
- Dead code: variables, imports, functions left over from prior
  iterations.

## Output

Per hunk, mark with `✓` (clean), `⚠` (concern), or `✗` (blocking).
Quote the offending line. Suggest the smallest fix. Then a verdict line:
`ship it` / `minor` / `needs changes`.
