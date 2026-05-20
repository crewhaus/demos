---
name: approval-workflow
description: |
  How to ask the user for approval before destructive or external
  actions. Auto-loads when the agent is about to call a tool flagged
  as side-effecting (send, post, transfer, delete, schedule).
triggers:
  - "send"
  - "post"
  - "delete"
  - "transfer"
  - "schedule"
  - "book"
  - "buy"
  - "purchase"
---

# approval-workflow — explicit confirmation for side effects

The `permission-engine` enforces approval for built-in destructive
tools (`Bash`, `Write`, `Edit`). For MCP-connected tools (Gmail send,
calendar create, Stripe charge) you have to enforce the contract by
convention — the permission engine doesn't know they're destructive.

## The contract

Before calling any MCP tool whose name contains these substrings,
PAUSE and ask the user:

- `send` (email, message, payment)
- `post` (social, forum, status)
- `create` (calendar event, ticket, doc)
- `delete` (anything)
- `transfer` (money, file ownership)
- `schedule` (event, meeting)
- `pay` / `charge` / `purchase` / `book`

Anything that:
- Is visible to people other than the user
- Costs money
- Sets up a future obligation
- Is hard to reverse

## How to ask

Stay in the same thread. Use ONE message. Make the answer a y/n:

> Ready to send the email to alice@example.com with subject "Quick
> Q on Tuesday" and the body I drafted above. ✅ y / ❌ n?

Wait for the user's reply. Treat anything other than an affirmative
("y", "yes", "send it", "go", "do it") as a NO — even silence. If
unclear, ask again with the same y/n.

## How to acknowledge

After the user says yes and the tool returns success:

- Reply with one short line confirming. "Sent." / "Created." /
  "Posted."
- DO NOT re-summarise what you just sent. They saw the preview;
  they don't need to read it again.

After the user says no:

- "OK, holding off."
- DO NOT default-suggest an alternative unless they ask. They might
  want to think.

## Edge cases

- **User says yes, then immediately "wait, no, hold on"**: cancel
  the action if it's reversible (e.g. calendar event), apologize
  if it's not. Be honest about reversibility.
- **Tool fails after approval**: surface the failure in one line
  with the error string. Suggest one retry option.
- **User asks for the same destructive action again in the same
  thread**: still ask. Approval is per-action, not per-session,
  because the params may have changed.

## What NOT to do

- Don't batch approvals ("ready to send these 3 emails?"). One
  approval per action, even if it's tedious. The user can say "yes
  to all" themselves if they want.
- Don't infer "I assume you want me to send it since you wrote it"
  — that's exactly the kind of inference that leads to embarrassing
  sends. Ask.
- Don't add disclaimers ("I'll send unless you object in 10
  seconds"). The user said something or they didn't; default to no.
