# Recipe 67 — Human-in-the-loop approvals that survive headless

**Pillar:** Pillar 3 — the loop is governed, not just permitted.
**Catalog modules:** `permission-engine`, `session-store` (`PendingApprovalStore`), `runtime-core` (the park/resume seam), `channel-adapter-base` + `channel-adapter-slack` (approvals Block Kit + the `/<adapter>/actions` route), plus the CLI's `approvals` verbs ([`apps/cli/src/approvals-cli.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/approvals-cli.ts)). Item **G11**.
**Shipped in:** crewhaus 0.4.0 ([CHANGELOG](https://github.com/crewhaus/factory/blob/main/CHANGELOG.md), Batch C).

[Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) covers the
static engine: a rule of type `alwaysAllow` / `alwaysDeny` / `alwaysAsk`
attaches a policy to a tool, and the engine evaluates it per call. That works
cleanly in the REPL, where an `alwaysAsk` rule prints a synchronous prompt and a
human answers. But most production surfaces have **no human at the keyboard** —
a single-turn `run`, a Slack daemon, a gateway request. Before 0.4 an `ask` on
one of those surfaces had nowhere to go, so it **collapsed to a denial in place**
and told you to widen the rule to `alwaysAllow`. That's the exact inverse of the
safety intent: the way to get past a governance gate was to remove the gate.

0.4 fixes that with **`permissions.ask_mode: pause`** (the new default). Instead
of collapsing, an ask on a non-interactive surface **parks** the tool call as a
durable pending approval, notifies a human out of band (Slack Approve/Deny
buttons on the channel shape), and lets a later `grant` / `deny` decision resume
the parked call pre-resolved.

## What this recipe shows

- `permissions.ask_mode: pause` vs `deny` — and why `pause` is now the default
- What a headless `run` does when it hits an `alwaysAsk` tool (park, exit 36)
- Resolving parks with `crewhaus approvals list | show | grant | deny`
- Slack Approve/Deny buttons on the channel shape
- Resuming a parked cli session with `crewhaus runs resume`
- Contrast with the pre-0.4 `ask → deny` collapse

## Prerequisites

- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) for the
  static rule engine (`alwaysAllow` / `alwaysDeny` / `alwaysAsk`) this sits on.
- The [`starters/channel`](../starters/channel) spec, which already gates `Bash`
  behind `alwaysAsk` — the ideal thing to watch park.
- For the Slack half: a channel daemon reachable by Slack's interactivity
  webhook (Recipe 30 — Channels covers the daemon + tunnel setup).

## The knob

`ask_mode` lives on the `permissions:` block and takes two values:

```yaml
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAsk
      pattern: Bash(**)
  # ask_mode: pause   # ← the DEFAULT; shown for clarity, omit it to get it
```

- **`pause`** (default, the safe direction): on a non-interactive surface a tool
  call that resolves to `ask` **parks**. The runtime persists a `PendingApproval`
  to the session store, publishes an `approval_requested` trace event, fires the
  out-of-band notification (Slack, if wired), and ends the run through the
  classified-failure machinery: `run_failed` class `approval_pending`, **exit
  code 36** (beside the budget cap's 33, the timers' 34, and the quality floor's
  35), plus a resume token.
- **`deny`**: restores the pre-0.4 behaviour — an ask on a non-interactive
  surface becomes a denial in place, with a message pointing you at
  `permissions.rules`. Use it only when you deliberately want a hard "no" rather
  than a parked "later."

The REPL is unaffected either way — it always keeps its synchronous prompt.

`ask_mode` is deliberately **excluded from `OPTIMIZABLE_PATHS`**: it's a
human-in-the-loop safety posture, not a quality knob, so the optimizer can't
silently flip a `pause` to a `deny` (or back) while searching for a better spec.

## Watch a headless run park

The channel starter gates `Bash` behind `alwaysAsk` and leaves `ask_mode` at its
`pause` default. Drive it as a single-turn run — a surface with no human prompt —
and ask it to do something that needs the shell:

```bash
cd starters/channel
crewhaus run crewhaus.yaml --prompt "how many markdown files are in this repo?"
```

The agent reaches for `Bash`, the permission resolves to `ask`, and because
there's no interactive surface the run **parks** instead of denying:

```
awaiting tool approval
  `Bash` requires approval on a non-interactive surface (single-turn); the run
  is parked as approval appr_9f2c1a7b3e4d5f60
  → grant or deny it out of band, then rerun:
      crewhaus approvals grant appr_9f2c1a7b3e4d5f60
```

The process exits `36` (`approval_pending`) — a **resumable pause, not a
terminal failure**. Failure triage ([Recipe 61](61-self-building-evals.md))
knows this: `approval_pending` is in `NON_FAILURE_CLASSES`, so parks never
cluster as failures — they surface through `crewhaus approvals` instead.

## Resolve it from the CLI

`crewhaus approvals` reads and writes the file-backed store under
`.crewhaus/sessions/` (the same store the runtime parks against and re-reads to
resume). List what's waiting:

```bash
crewhaus approvals list
```

```
ID                       STATUS   TOOL  SURFACE      AGE  SESSION
appr_9f2c1a7b3e4d5f60    pending  Bash  single-turn  8s   sess_1c3e...

1 approval(s), 1 pending. Resolve with: crewhaus approvals grant|deny <id>
```

Before you decide, inspect **exactly what a grant authorizes** — `show` prints
the verbatim tool input:

```bash
crewhaus approvals show appr_9f2c1a7b3e4d5f60
```

```
id:         appr_9f2c1a7b3e4d5f60
status:     pending
tool:       Bash
surface:    single-turn
...
input:
  {
    "command": "find . -name '*.md' | wc -l"
  }
```

Record a decision. `--by` stamps the deciding identity (falls back to
`$CREWHAUS_USER`, then `cli`):

```bash
crewhaus approvals grant appr_9f2c1a7b3e4d5f60 --by max   # or: deny
```

```
granted appr_9f2c1a7b3e4d5f60 — Bash (one-shot — the runtime consumes it on the next matching tool call)
```

A `grant` is **one-shot by default** (`--once`): the runtime consumes it the
first time it re-issues the same `(tool, input)` call, so a later identical call
re-asks under a fresh id. That keeps a single approval from becoming a standing
permission.

## Resume the parked run

The session store keeps only name/target/model, so `runs resume` re-resolves the
spec from `--spec` (else `crewhaus.yaml` in the cwd), replays the transcript, and
re-issues the parked call — now pre-approved:

```bash
crewhaus runs resume sess_1c3e... --prompt "how many markdown files are in this repo?"
```

The re-issued `Bash` call finds the recorded `grant`, runs, and the decision is
consumed (publishing `approval_resolved`). Had you `deny`d, the parked call is
refused with a note on resume and the loop continues without it.

## Slack Approve/Deny buttons

On the **channel shape** the story closes on the surface the human already
lives in. When the daemon parks an approval it posts an interactive Block Kit
message with **Approve** / **Deny** buttons into the run's thread:

```yaml
name: hello-channel
target: channel
agent:
  model: claude-sonnet-5
  instructions: |
    You are a helpful Slack bot. Use the shell when a question needs it.
  tools: [read, bash]
channels:
  slack:
    botToken: $SLACK_BOT_TOKEN
    signingSecret: $SLACK_SIGNING_SECRET
routing:
  sessionKey: thread
permissions:
  rules:
    - type: alwaysAllow
      pattern: Read
    - type: alwaysAsk
      pattern: Bash(**)
  # ask_mode: pause is the default
```

Clicking a button POSTs Slack's interactivity webhook (a `block_actions`
payload) back to the daemon's `/<adapter>/actions` route, which
**verifies → resolves → acks → resumes**: it records the decision in the same
approval store the CLI uses, replaces the buttons with a one-line "Approved by
@max" / "Denied by @max" context block, and re-drives the parked turn. The
approval id rides in both the button `value` and the actions block's `block_id`,
so it survives even if Slack ever elides the `value`.

Because the CLI and the Slack route share **one** store, the two paths are
interchangeable: an operator can `crewhaus approvals grant` a park that was
raised in Slack, or approve from the thread a park raised by a cron `run`.

## Contrast: the old ask → deny collapse

Set `ask_mode: deny` (or run a build with no approvals store wired) and the same
headless `Bash` call reverts to the pre-0.4 behaviour — a denial in place:

```
tool denied: `Bash` defaulted to "ask" and this non-interactive surface has no
way to prompt (ask_mode: "deny"). Add an explicit rule to permissions.rules in
your spec, e.g. `{ type: alwaysAllow, pattern: Bash }`, run in REPL mode where
"ask" can prompt, or set ask_mode: pause with an approvals store to park for
out-of-band approval.
```

That message is the whole reason `pause` is now the default: the only ways
forward it offered were to **remove the gate** (`alwaysAllow`) or to abandon
headless operation (the REPL). `pause` gives you the third option the safety
model actually wanted — keep the gate, and let a human answer it later.

## What each verb does

| Verb                          | Effect                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `approvals list`              | All parked approvals under `.crewhaus/sessions/`, newest first (`--json` for raw records)   |
| `approvals show <id>`         | Full detail for one approval, including the verbatim tool input a grant would authorize     |
| `approvals grant <id>`        | Record a GRANT — one-shot by default (`--once`); the next matching call proceeds pre-approved |
| `approvals deny <id>`         | Record a DENY — the parked call is refused with a note when the run resumes                  |
| `runs resume <session>`       | Replay the parked session and re-issue the call, consuming the recorded decision             |

`--dir <root>` points any verb at a harness other than the cwd; `--by <who>`
stamps the deciding identity on `grant` / `deny`.

## When to NOT reach for this

- **On the REPL.** Interactive `run` already prompts synchronously; `ask_mode`
  only governs surfaces with no human at the keyboard.
- **For a hard, permanent "no."** That's `alwaysDeny`, not an `alwaysAsk` you
  keep denying. Parks are for calls a human *might* approve later.
- **As a standing permission.** A one-shot `grant` is consumed on use by design.
  If a tool should always run unattended, that's an `alwaysAllow` rule — don't
  paper over it by pre-granting.
- **To gate *intent* rather than *authorization*.** Whether the agent has the
  right *reason* to call a tool it's allowed to call is the justification gate —
  [Recipe 53 — Justification gates](53-justification-gates.md).

## What to read next

- **The static engine this layers on.** [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
- **Gating the rationale, not just the permission.** [Recipe 53 — Justification gates](53-justification-gates.md).
- **Where `approval_pending` sits in triage.** [Recipe 61 — Self-building evals](61-self-building-evals.md).

## Pointers to source

- **The `ask_mode` grammar:** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts) (the `permissionsBlock` `ask_mode: pause | deny`).
- **The park/resume seam + `approval_requested`:** [`packages/runtime-core/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/runtime-core/src/index.ts).
- **The `approvals` verbs:** [`apps/cli/src/approvals-cli.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/approvals-cli.ts) (rendering) and the wiring in [`apps/cli/src/index.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/index.ts).
- **The pending-approval store:** [`packages/session-store`](https://github.com/crewhaus/factory/blob/main/packages/session-store) (`PendingApprovalStore`, `.crewhaus/sessions/approvals.jsonl`).
- **Slack Approve/Deny:** [`packages/channel-adapter-slack/src/approvals.ts`](https://github.com/crewhaus/factory/blob/main/packages/channel-adapter-slack/src/approvals.ts) and the shared [`packages/channel-adapter-base/src/approvals.ts`](https://github.com/crewhaus/factory/blob/main/packages/channel-adapter-base/src/approvals.ts).
