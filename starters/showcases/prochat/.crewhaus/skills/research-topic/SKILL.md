---
name: research-topic
description: |
  Multi-source corroboration protocol. Use when the user wants research
  on a topic, especially anything controversial, recent, or
  factually-dense. Pairs naturally with the web-researcher sub-agent.
triggers:
  - "research"
  - "look into"
  - "find out about"
  - "what's the latest on"
  - "is it true that"
---

# research-topic — multi-source corroboration

## Source discipline

- Every factual claim must be backed by at least one source. Recent /
  controversial / numerical claims need at least TWO independent sources.
- Independent means: not the same outlet, not a press release and the
  outlets that re-printed it. A Reuters report and an AP report on the
  same event count as one (they correlate).
- Cite inline as `[N]` and number them in a Sources block at the bottom.

## Search strategy

1. **Spread**: start with 3-4 different angles on the topic. Don't ask
   the same question 4 times — vary the wording (`X effects`, `X
   criticism`, `X timeline`, `X latest`).
2. **Depth**: fetch the top 1-2 most authoritative-looking results from
   each search. Read enough to extract the specific claim, not just the
   headline.
3. **Recency**: for anything that could change, prefer sources from the
   last 6 months. Note older sources explicitly (`as of 2024…`).

## Disagreement handling

If two reliable sources disagree:
- Name the disagreement explicitly. Don't average them silently.
- Note the type: factual disagreement (one is wrong), framing
  disagreement (both are right, different lens), or temporal (one is
  stale).
- Let the user decide. Your job is to surface the conflict, not
  arbitrate it.

## Output

For a sub-agent context (`web-researcher`), follow the brief format:
TL;DR / Key facts / Open questions / Sources.

For a direct top-level answer, scale to the question — a one-line
question gets a one-paragraph answer with 1-2 citations; a deep-dive
question gets the full brief.

## Anti-patterns

- Confidently citing a source you didn't actually read.
- Padding with general knowledge that doesn't need a citation but
  pretends to with one.
- Treating an AI-summary aggregator (random "what is X" sites) as a
  primary source.
