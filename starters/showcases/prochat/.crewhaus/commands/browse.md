---
description: Dispatch the web-researcher sub-agent to research a topic across multiple sources.
argument-hint: "<topic or question>"
---
Dispatch the `web-researcher` sub-agent via `Task` with the input:

  "$ARGUMENTS"

When the sub-agent returns, present its structured brief verbatim:

- **TL;DR**
- **Key facts** (with `[N]` citations)
- **Open questions**
- **Sources** (numbered list)

Then add a single closing line offering a follow-up: e.g. "Want me to
go deeper on <one of the open questions>?"
