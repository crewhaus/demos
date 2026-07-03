# Recipe 60 — Fleet & teams

**Catalog modules:** `fleet-inventory`, `spec-registry`, `deployment-controller`, `propose-driver`, `knowledge-sync`, `retire-lifecycle`, `module-marketplace-client`.
**Shipped:** crewhaus 0.2.0 (`crewhaus fleet`, approval-gated promotion + `crewhaus propose`, `crewhaus knowledge sync`, `crewhaus retire`).

Every CLI command up to 0.2.0 was single-cwd: one harness, one
directory. The moment you run a *second* harness — or a *second
teammate* touches the first — you hit walls. `crewhaus fleet` gives you
a cross-harness inventory and bulk operations; approval-gated promotion
plus `crewhaus propose` make a spec change a reviewable governance
event; `knowledge sync` shares learned memories and graders across
harnesses; and `crewhaus retire` is the lifecycle's missing last phase.

You'd reach for this when:

- You run **more than one harness** and want one status view instead of
  `cd`-ing into each.
- A spec change needs **teammate review and an approval gate** before it
  reaches a protected environment.
- You want harnesses to **share what they've learned** (lessons,
  graders, few-shot pools).
- You're **decommissioning** a harness and need a clean, audited
  shutdown.

## Prerequisites

- [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md) for
  the spec registry and env pins fleet operations act on.
- [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md)
  for the write-back that `propose` wraps in a review PR.

## The fleet inventory

`crewhaus fleet` discovers harness directories under a root and gives
you a status table per harness — pinned version, last pass rate, 7-day
cost, unrated feedback, env pins:

```bash
crewhaus fleet list --root ~/harnesses      # every discovered harness
crewhaus fleet status --root ~/harnesses    # the status table
```

Bulk **read** operations fan out across the fleet:

```bash
crewhaus fleet run doctor --root ~/harnesses     # doctor every harness
crewhaus fleet run eval --root ~/harnesses --filter "support-*"
```

`--filter` narrows a bulk run to matching harness names. A bulk op that
would **mutate** (compile write-back, upgrade, deploy) requires
`--allow-mutating` plus a per-harness confirm; `--yes` skips the
interactive confirm for CI:

```bash
crewhaus fleet run upgrade --root ~/harnesses --allow-mutating --yes
```

The read/mutate split is deliberate: `fleet status` can't hurt you, but
a fleet-wide write is gated behind an explicit opt-in.

## Approval-gated promotion

Promoting a spec to a **protected** environment (declared in
`.crewhaus/environments.json`) can require a recorded approval quorum
and/or a green PR check before the pin flips:

```bash
crewhaus deploy promote support-agent --from staging --to prod \
  --require-approval --check-pr
```

`--require-approval` refuses to flip a protected env's pin until the
quorum is met — recorded approvals under `.crewhaus/approvals/` and/or a
green proposal PR (`--check-pr` drives `gh pr checks`). The gate
decision — met *or* refused — is audit-logged as a
`governance_approval` entry. A rollback to a protected env clears the
same gate; a live pin flip is a live pin flip whichever verb causes it.

## `crewhaus propose` — a spec change as a review PR

The optimizer and advisor can write a spec back directly, but on a team
you want the change to arrive as a **reviewable PR**, never a silent
overwrite. `crewhaus propose` is the governance wrapper: it packages a
proposed spec into a review artifact and opens a PR. It never
auto-merges:

```bash
crewhaus propose proposed-crewhaus.yaml \
  --current crewhaus.yaml \
  --source optimize \
  --optimize-dir .crewhaus/optimize/opt_a8f3b21c \
  --as-version v5
```

`--source` records provenance (`optimize` | `advise` | `model-scan` |
`manual`); `--optimize-dir` folds the run's score delta and patch
rationale into the changelog and PR body. Add `--dry-run` to assemble
the bundle and print the plan without touching git or `gh`.

This is the same pattern the flywheel's scheduled path uses — accepted
improvements arrive as PRs for a human to merge.

## Cross-harness knowledge sync

Harnesses accumulate learned artifacts — memories, graders, prompt
lessons. `crewhaus knowledge sync` shares them across the fleet through
a shared store, with redaction on by default:

```bash
crewhaus knowledge sync --root ~/harnesses --push    # publish this harness's learnings
crewhaus knowledge sync --root ~/harnesses --pull    # absorb the shared store
crewhaus knowledge sync --root ~/harnesses --dry-run # plan without writing
```

`--root` scopes discovery; `--shared` overrides the shared-store
directory. Redaction runs on every push — recalled/injected content is
boundary-classified and secret-redacted before it leaves a harness.
`--no-redact` exists for local/dev only; never use it against a shared
store that other people read.

## `crewhaus retire` — the clean shutdown

Decommissioning is the lifecycle phase everyone forgets. `crewhaus
retire` does it properly: archive sessions/feedback/memories,
retention-purge, rotate-then-revoke secrets, unpin/tombstone the
registry entry, and emit a final compliance bundle proving a clean
shutdown:

```bash
crewhaus retire crewhaus.yaml --dry-run                 # print the plan first
crewhaus retire crewhaus.yaml --archive ~/retired/support-agent
crewhaus retire crewhaus.yaml --archive ~/retired/support-agent \
  --push-knowledge                                       # share lessons out first
```

It **refuses to retire a harness with an active pin** unless you pass
`--force` — you don't want to tombstone a spec that prod is still
serving. `--push-knowledge` runs a `knowledge sync --push` first so the
harness's lessons outlive it. Always run `--dry-run` before the real
thing.

## The marketplace CLI

Publishing and pulling shared plugins/templates rounds out the team
story. The marketplace CLI lists, searches, installs, and publishes over
a registry backend:

```bash
crewhaus plugins list
crewhaus plugins search --query redact
crewhaus templates use <template-name> --into ./new-harness
```

See [Recipe 26 — Template Marketplace](26-template-marketplace.md) for
the registry model and the publish loop.

## A team workflow, end to end

```
fleet status                     → one view of every harness
flywheel run (Recipe 56)         → a candidate improvement, per harness
propose --source optimize        → the improvement becomes a review PR
(review + approve)               → teammate approves
deploy promote --require-approval → the gate clears; prod pin flips
knowledge sync --push            → the winning lesson spreads to the fleet
retire (when a harness sunsets)  → clean, audited shutdown
```

## When this is overkill

- **One harness, one operator.** `fleet`, `propose`, and approval gates
  are for scale and teams. A solo CLI agent doesn't need them — use
  `deploy promote` without `--require-approval`.
- **No shared learnings yet.** `knowledge sync` needs harnesses that
  have actually accumulated memories/graders; it has nothing to move on
  day one.

## What to read next

- **The registry + env pins fleet acts on.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **The write-back `propose` wraps.** [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md).
- **The marketplace registry model.** [Recipe 26 — Template Marketplace](26-template-marketplace.md).
- **Multi-tenant deployment.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).

## Pointers to source

- **Spec registry:** [`packages/spec-registry`](https://github.com/crewhaus/factory/blob/main/packages/spec-registry).
- **Deployment controller:** [`packages/deployment-controller`](https://github.com/crewhaus/factory/blob/main/packages/deployment-controller).
- **Marketplace client:** [`packages/module-marketplace-client`](https://github.com/crewhaus/factory/blob/main/packages/module-marketplace-client).
- **Module catalog reference:** §28, §34, §40 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
