---
name: heartbeat-decide
description: |
  Decide what's worth doing on a heartbeat tick. Loads when the agent
  is woken by the scheduled heartbeat (NOT by inbound user message).
  Pairs with HEARTBEAT.md at the demo root.
triggers:
  - "heartbeat"
  - "wake"
  - "tick"
---

# heartbeat-decide — what to do when nobody asked

The default verdict on a heartbeat is **silence**. Acting requires a
specific, time-sensitive reason that you can name in one sentence.

> **Note:** the heartbeat feature itself is deferred to Phase 3 §3.1
> of the plan. This skill is forward-compatible — once `heartbeat:`
> lands on the channel schema, the agent loads this skill on each
> tick.

## Good reasons to act (in priority order)

1. **Time-sensitive event the user explicitly asked you to surface.**
   "Remind me at 4pm to leave for the airport." If 4pm is now → ping
   them. Otherwise → silent.
2. **Approval owed > 24h.** You asked the user something earlier in
   the thread; they didn't reply; the action depends on it. One
   gentle nudge ("Still need a yes/no on X?"). Then drop it.
3. **State change you're explicitly subscribed to.** A connected
   MCP-todo says a task is now due. Single-line surface in the most
   recent channel.
4. **Morning brief, if configured.** First tick after 08:00 local
   and the user opted in: one-paragraph "today: calendar / 3 todos /
   weather". Otherwise → silent.

## Good reasons NOT to act

- **Nothing has changed** since the last tick → silent return. This
  is the default.
- **The user is sleeping** (00:00–07:00 local, or DND window
  configured in your MCP-calendar) → silent return.
- **The user said "/pause"** in any channel → silent return until
  pause expires.
- **Anything you came up with that's just chatty** ("just checking
  in!", "remember to drink water!") → silent. Always.

## Reasoning trace (output of every tick)

Whether or not you act, your tool-call sequence ends with a single
trace message to the event log:

```
heartbeat_tick: { reason: "silent" | "<one-sentence reason>", action: "..." | null }
```

This makes heartbeats auditable. If the user reviews their event log
and finds 50 silent ticks and 2 nudges, that's the right shape. If
they find 50 nudges, the skill is wrong and you need to retune.

## On tone

Heartbeat-triggered messages must be even MORE terse than reactive
ones. The user did not ask, so you owe brevity. Lead with the
specific timestamp or trigger, e.g.:

- ✅ "4pm — time to leave for the airport."
- ✅ "Owe me a y/n on the report draft?"
- ❌ "Hi! Just wanted to check in — hope your day is going well!"
- ❌ "I noticed it's been a while since we talked!"
