# Heartbeat playbook

> Read on every heartbeat tick. Pairs with the `heartbeat-decide`
> skill at `.crewhaus/skills/heartbeat-decide/SKILL.md`.

The default verdict on every tick is **silence**. Action requires a
specific, time-sensitive reason you can name in one sentence.

## Local config (edit these for your life)

```yaml
# Timezone for "morning" / DND windows. Change to yours.
timezone: America/Los_Angeles

# Don't ever ping during this window (local time).
dnd_window: { from: "00:00", to: "07:00" }

# Optional: a one-line daily brief at this time, in your most-recent
# channel. Set to null to disable.
morning_brief_at: "08:30"

# Channels to surface heartbeat actions in. "latest" = most recent
# user-initiated thread.
default_channel: latest
```

## Good reasons to act (in priority order)

1. **Time-sensitive event the user explicitly asked you to surface.**
   "Remind me at 4pm to leave for the airport." If 4pm is now → ping.
2. **Approval owed > 24h.** You asked the user a yes/no earlier in
   the thread; they didn't reply; the action depends on it. One
   gentle nudge. Then drop it.
3. **State change you're explicitly subscribed to.** A connected
   MCP-todo says a task is now due. Single-line surface.
4. **Morning brief, if configured above.** One paragraph: calendar
   highlights + open todos + weather. Skip on weekends unless asked.

## Good reasons NOT to act

- Nothing has changed since the last tick → silent.
- User is in the DND window above → silent (queue urgent items for
  the next non-DND tick).
- User said `/pause` in any channel → silent until pause expires.

## Anti-patterns (never)

- "Just checking in!" / "Hope you're doing well!"
- Reminding the user of something they already know.
- Multiple nudges on the same outstanding ask. One nudge, then drop.
- Surfacing the same news / RSS / blog you mentioned in the last tick.

## Audit log

Every tick — silent or not — logs to `.crewhaus/events.jsonl`:

```json
{
  "event": "heartbeat_tick",
  "at": "2026-05-19T15:00:00Z",
  "reason": "silent" | "<one-sentence reason>",
  "action": null | { "channel": "slack", "thread": "...", "text": "..." }
}
```

If you skim the log later and 90%+ of ticks are silent, the agent is
calibrated. If 20% are noisy nudges, retune by editing this file
(specifically: tighten the "Good reasons to act" criteria).
