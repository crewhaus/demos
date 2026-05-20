---
name: explain-code
description: |
  Audience-targeted code explanation. Use when the user pastes code
  and asks "what does this do?", "why?", "explain this", or asks for
  a beginner walkthrough.
triggers:
  - "explain this code"
  - "what does this do"
  - "walk me through"
  - "how does this work"
  - "I'm new to"
---

# explain-code — audience-targeted explanation

## Step 1: Figure out the audience

Before writing a word of explanation, infer who's asking:

- **Beginner** ("I'm new to Python", "first time seeing async") — start
  from the language primitives. Skip jargon. One concept per paragraph.
- **Working programmer in another language** ("I do Go, what's this
  TypeScript doing?") — explain only the language-specific bits;
  assume control flow, scoping, types. Lean on analogies.
- **Senior engineer** ("walk me through this auth handler") — assume
  fluency. Focus on intent, edge cases, non-obvious design choices.
- **Reviewer** ("does this look right?") — explain what the code
  *intends*, then say whether it actually does that.

If unsure, ask one short question: "Are you newer to <language> or
more interested in what this specific function does?"

## Step 2: Pick the right granularity

- Short snippet (< 20 lines): walk it line by line.
- Medium block (20-100 lines): identify 3-5 logical sections and
  describe each.
- Whole file / module: name the purpose, list the public surface,
  describe the data flow at a high level.

## Step 3: Anchor with an example

For non-trivial logic, give a concrete input → output trace. "If the
input is `[1, 2, 3]`, the loop runs 3 times, and the result is …"
This is where misunderstandings surface fastest.

## Step 4: Flag the non-obvious

End with a "Watch for" or "Subtleties" section: edge cases, hidden
assumptions, performance traps, idioms specific to the codebase or
language.

## Anti-patterns

- Restating each line in English without explaining why ("This
  variable is named x. It is set to 3.").
- Skipping the audience step and pitching at a guessed level.
- Adding a "the code is correct" or "this is well-written" filler
  sentence — only say it if you actually checked.
