# Recipe 57 — The advisor loop

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `advisor` (session-mining rule library), `spec-patch`, `eval-optimizer-orchestrator`, `session-persistence`.
**Shipped:** crewhaus 0.2.0 (`crewhaus advise`, `optimize --from-advice`, `doctor --context-pressure`).

The flywheel in [Recipe 56](56-self-improvement-flywheel.md) tunes one
thing: `agent.instructions`. But most of what goes wrong with a real
agent isn't the prompt — it's `max_tokens` too low so turns truncate,
compaction thrashing, a tool that fails half the time, permission-ask
churn, chronic context pressure that wants a sub-agent split. Those
signals live in session telemetry, not in a dataset.

`crewhaus advise` mines that telemetry into typed, eval-validated spec
suggestions. `crewhaus optimize --from-advice` applies them through the
same regression gate the flywheel uses. It's the observer that suggests
changes *beyond the prompt* — with the eval gate making auto-apply safe.

You'd reach for this when:

- Your agent works but **feels off** — truncated answers, repeated
  tool failures, slow turns — and you want the system to tell you
  which knob to turn.
- You want spec suggestions grounded in **what actually happened**, not
  a static lint.
- You want to apply those suggestions **only when they pass an eval**.

## Prerequisites

- [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md)
  for the eval-gated write-back machinery `--from-advice` reuses.
- Some real sessions on disk under `.crewhaus/sessions/`. The advisor
  mines history; it has nothing to say about a harness that's never run.

## Step 1 — mine sessions for advice

Run `advise` from inside the harness directory. It walks
`.crewhaus/sessions` (and `.crewhaus/audit`) and runs a rule library
that maps trace patterns to typed `SpecPatch` suggestions, each
pre-checked with `validatePatch`:

```bash
crewhaus advise --all              # mine every session
crewhaus advise --session sess_0a1b2c3d4e5f6789   # mine one
```

What it looks for:

- **repeated tool failures** → a tool config or removal suggestion
- **`max_tokens` truncation pressure** → raise `agent.max_tokens`
- **compaction thrash** → tune `compaction.threshold` / `curate`
- **permission-ask churn** → a `permissions suggest` pointer
- **stop-reason anomalies** and **learned `failure_taxonomy` / loop-break rules**
- **sub-agent splits** under chronic context pressure

By default it writes `suggestions.json` + an HTML evidence report into
`.crewhaus/advice/`. Add `--json` to print machine-readable findings to
stdout, or `-o <dir>` to redirect the artifacts:

```bash
crewhaus advise --all -o .crewhaus/advice --json
```

> **The in-run half is load-bearing.** Several signals — tool
> durations, recovery events, permission decisions — never reach the
> session JSONL on their own. The compiled harness ships an env-gated
> bus subscriber that tallies them live and persists an
> `advisor_summary` event, plus prints an end-of-session digest
> ("3 findings — run `crewhaus advise sess_x`"). That subscriber is
> what makes the offline mining possible.

## Step 2 — read the suggestions

Open the HTML report, or read `suggestions.json`. Each entry is a
`SpecPatch` with the evidence that motivated it — the sessions, the
counts, the trace pattern. This is a review surface, not an
auto-apply: you decide which suggestions are worth an eval.

The patches only ever target fields in `OPTIMIZABLE_PATHS` —
`agent.max_tokens`, `compaction.curate`, `compaction.threshold`,
`failure_taxonomy`, retrieval knobs, `security.justification`. Anything
outside that whitelist can't be constructed as a patch, so the advisor
can't propose rewriting your permission rules or model.

## Step 3 — apply through the eval gate

`crewhaus optimize --from-advice` is the apply path. Instead of running
the mutation search, it applies each advisor patch in-memory, compiles,
evaluates on the dev split, and writes it back **only when the gate
passes**:

```bash
crewhaus optimize crewhaus.yaml \
  --from-advice .crewhaus/advice/suggestions.json \
  --dataset registry:support-agent-ratings \
  --write-back
```

`--from-advice` is mutually exclusive with `--mutator` / `--iterations`
(it's applying known patches, not searching for new ones), but
`--dataset` / `--graders` / `--ratings` still resolve as usual — the
apply path needs an eval to gate on. Each patch is accepted, rejected,
or composed based on its own dev-split delta; a successful `--write-back`
runs the same auto-register + changelog flow as `compile`.

This chains cleanly with the flywheel: `advise → optimize --from-advice`
is the "suggestions beyond the prompt" half of the same nightly loop.

## `doctor --context-pressure` — the fast triage

Before mining full sessions, `doctor --context-pressure` gives you a
one-shot report over recent sessions: truncation recoveries, compaction
fires, snip-vs-autocompact ratio, the relevant spec knobs, and the
`advise` / `optimize` commands to run next. It's a report, not a gate —
it always exits 0:

```bash
crewhaus doctor --context-pressure                 # scans the last 20 sessions
crewhaus doctor --context-pressure --sessions 50   # widen the window
```

If it reports chronic pressure, that's the signal to run `advise` and
look for a `max_tokens` bump or a sub-agent split in the suggestions.

## Related: `permissions suggest` and the `tools` namespace

Two adjacent commands mine the same session history for non-prompt
improvements:

```bash
# Mine ask/deny history into settings.json permission rules.
crewhaus permissions suggest --sessions all
crewhaus permissions suggest --apply       # interactive-confirm; never eval-gated

# Discover, rank, and audit tools against real usage.
crewhaus tools list                        # every builtin + metadata
crewhaus tools suggest                      # rank builtins vs agent.instructions
crewhaus tools audit --sessions all        # unused / failing / readOnly grants
```

`permissions suggest --apply` is **interactive-confirm only** and never
eval-gated — permission changes are a human decision, not an
optimization. That's deliberate: the eval gate governs quality knobs;
the security floor stays a person's call.

## What each command writes

| Command                              | Writes                                                        |
| ------------------------------------ | ------------------------------------------------------------- |
| `crewhaus advise`                    | `.crewhaus/advice/suggestions.json` + `report.html`           |
| `crewhaus optimize --from-advice`    | `.crewhaus/optimize/<runId>/` + (on accept) the spec + registry |
| `crewhaus doctor --context-pressure` | nothing — prints a report, exits 0                            |
| `crewhaus permissions suggest --apply` | `settings.json` rules (after interactive confirm)           |

## When to NOT reach for the advisor

- **On a harness with no traffic.** The advisor is a telemetry miner;
  it needs sessions to mine.
- **For prompt-quality problems.** If the failures are instruction
  following, not tool/context mechanics, the flywheel
  ([Recipe 56](56-self-improvement-flywheel.md)) is the right loop.
- **To change permissions automatically.** Suggestions are fine;
  `--apply` is interactive by design. Never wire it into an unattended
  cron.

## What to read next

- **The prompt-tuning half of the loop.** [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md).
- **The permission grammar `permissions suggest` writes into.** [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
- **Context curation the advisor's compaction suggestions lean on.** [Recipe 52 — Active Context Curation](52-context-curation.md).

## Pointers to source

- **Advisor rule library:** [`packages/eval-optimizer-orchestrator`](https://github.com/crewhaus/factory/blob/main/packages/eval-optimizer-orchestrator).
- **Patch validation / whitelist:** [`packages/spec-patch`](https://github.com/crewhaus/factory/blob/main/packages/spec-patch).
- **Module catalog reference:** §29, §46 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
