---
description: Fetch a URL (or read a local text file) and summarise in 3 sentences.
argument-hint: "<url-or-path>"
---
Summarise the resource at: **$ARGUMENTS**

1. Fetch:
   - If `$ARGUMENTS` is a URL, `WebFetch` it.
   - If it's a local path, the agent doesn't have generic Read access —
     suggest the user paste the text or convert to a URL.

2. Read the body. Skip nav/footer/ad boilerplate.

3. Write a 3-sentence summary:
   - Sentence 1: what is this and who wrote it?
   - Sentence 2: the single most important claim or finding.
   - Sentence 3: the most relevant context, caveat, or counterpoint.

4. Below the summary, add:
   - **Key terms**: 3-5 named entities or jargon terms a reader should
     know to read the original
   - **Read time**: rough word count / 250 wpm

Do NOT exceed 5 lines total. The user is summarising specifically to
avoid reading more.
