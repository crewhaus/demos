# Recipe 21 — Deployment and Canary

Manage spec versions like code. Store them in a registry, pin which
version each environment runs, promote and roll back via audit-logged
operations, and cut over from `vN` to `vN+1` with a percent-of-traffic
canary gated on a real eval-runner regression check.

You'd reach for this when:

- You operate **multiple environments** (dev, staging, prod) and need
  one source of truth for which spec is running where.
- You need **safe promotions** — vN+1 only goes to 100% if it
  out-evals vN.
- You need **fast rollback** — one command reverts an environment to
  the prior version, audit-logged.

If you're running one CLI agent locally, this is overkill. The
spec-registry and friends are designed for multi-tenant managed
deployments.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for
  the deployment surface.
- [Recipe 12 — Eval Harness](12-eval-harness.md) for the regression
  gate.

## The spec registry

The registry is **file-backed by default** under
`.crewhaus/specs/`:

```
.crewhaus/specs/
  agent-name/
    v1.yaml
    v2.yaml
    v3.yaml
    manifest.json
  _tenants/
    tenant-a/
      agent-name.json     # overlay: pin to a specific version for this tenant
```

`manifest.json` is the source of truth:

```json
{
  "versions": ["v1", "v2", "v3"],
  "envs": {
    "dev": "v3",
    "staging": "v3",
    "prod": "v2"
  },
  "aliases": {
    "stable": "v2",
    "latest": "v3"
  }
}
```

Operations on the registry:

```bash
crewhaus spec put agent-name v3 ./my-spec.yaml     # add a version
crewhaus spec list agent-name                       # list versions + env pins
crewhaus spec get agent-name v3                     # print a version's spec
crewhaus spec pin agent-name prod v3                # pin an env to a version
crewhaus spec alias agent-name stable v3            # update an alias
```

`pin` is the only operation that changes what production runs. Every
pin write is **audit-logged** in the deployment audit (entries of
kind `deployment_action` under `.crewhaus/audit/`).

## Tenant overlays

Some tenants want to pin to an older version (regulatory hold) or
a newer version (early-access beta). Overlay files in
`_tenants/<tenantId>/<spec>.json`:

```json
{ "version": "v2" }
```

The runtime resolution order:

1. Look for `_tenants/<tenantId>/<specName>.json`. If present, use
   that version.
2. Otherwise, use the env pin from `manifest.json` for the deployment's
   environment.

Overlays don't copy the spec — just point at an existing version. So
all tenants share the same vetted set of versions, but can be on
different ones.

## IR-passes — what runs between parse and emit

After the YAML parses and lowers to IR, the compiler runs zero or
more `ir-passes` ([packages/ir-passes](https://github.com/crewhaus/factory/blob/main/packages/ir-passes)).
Each pass is a `(IrNode) → IrNode` function that re-shapes the IR
without changing semantics:

| Pass                                 | What it does                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| `deadToolElimination`                | Removes `tools:` entries no instructions actually reference.       |
| `redundantMcpServerCollapse`         | Folds two MCP servers that declare the same `command + args` into one. |
| `permissionRuleCanonicalization`     | Sorts permission rules (deny > ask > allow), dedupes.              |
| `promptCachePrefixSort`              | Reorders cacheable prefix blocks so cache-hit rate is stable.       |

**Idempotency.** Every pass is `apply(apply(x)) === apply(x)`. That
means re-running the compiler on an already-canonicalized IR is a
no-op, which lets the migration engine round-trip safely.

## IR migrations

The IR schema evolves (new fields, renamed keys, fixed defaults).
Migrations are versioned `up`/`down` steps:

```typescript
// packages/migration-engine/src/migrations/2024-04-rename-foo.ts
export const migration = {
  fromVersion: "1.3",
  toVersion: "1.4",
  up(ir: IrV13): IrV14 { ... },
  down(ir: IrV14): IrV13 { ... }
};
```

To migrate the whole registry:

```bash
crewhaus migrate-all
```

Walks every spec in `.crewhaus/specs/`, computes the chain of `up`
steps from each spec's IR version to the current IR version, and
applies them. The chain is reversible — `migrate-all --down --target v1.3`
walks `down` steps.

Migration is the right answer when the schema changes; canary is the
right answer when the **behavior** changes. The two compose: a
migration shaves off the schema delta, then canary rolls the
behavior delta.

## The deployment controller

```bash
crewhaus deploy promote agent-name --from staging --to prod
crewhaus deploy rollback agent-name --env prod --to v2
```

Promote semantics:

1. Reads the version pinned to `from`.
2. Pins `to` to that version.
3. Audits the change with `{ actor, from-version, to-version, env }`.

Rollback semantics:

1. Asserts the target version exists.
2. Pins the env to it.
3. Audits with `{ actor, prev-version, target-version, env, reason }`.

Both are **atomic** writes to `manifest.json` (tempfile + rename).
A concurrent promote and rollback will serialize; one wins, the
other sees the updated manifest and fails-or-retries based on its
flags.

## The canary controller

A canary splits traffic between two versions. It's driven
**programmatically** by the `canary-controller` package — there's no
CLI verb; you instantiate the controller and call it from a rollout
script or your deploy automation:

```typescript
import { createCanaryController } from "@crewhaus/canary-controller";

const canary = createCanaryController({ registry, deploymentController });

// A canary is described by a config, not imperative start/stop calls.
const config = {
  name: "agent-name",
  fromVersion: "v2",   // pinned (control)
  toVersion: "v3",     // candidate (treatment)
  trafficPercent: 1,   // 1% of prod traffic goes to v3
  env: "prod",
};
```

`canary.route(config, requestId)` decides, per request, which version
handles it; the other 99% stays on the pinned version (v2). Routing is
**stable** by request hash:

```
sha256(tenantId | requestId) mod 100 < trafficPercent → toVersion
otherwise                                              → fromVersion
```

So the same user's requests stick to the same side. No flapping
between versions mid-conversation.

Ramp by raising `trafficPercent` across steps — the config is data, so
each step is a new config value:

```typescript
const at10  = { ...config, trafficPercent: 10 };
const at50  = { ...config, trafficPercent: 50 };
const at100 = { ...config, trafficPercent: 100 };   // full cutover
```

At 100%, a passing `evaluate()` (below) auto-promotes — it pins prod to
v3 and the canary ends.

## The regression gate

Before each weight bump, the regression runner compares versions on
the eval dataset. It's the `gate()` function from
`regression-runner` — also programmatic:

```typescript
import { gate } from "@crewhaus/regression-runner";

const verdict = await gate(prevRun, nextRun, {
  passRate: 0.95,
  scoreDelta: -0.02,
  latencyP95Ratio: 1.2,
});
// verdict is "pass" or "fail"
```

The gate:

1. Runs the eval dataset (`packages/dataset-registry`) against both
   versions.
2. Computes deltas: pass rate, mean score, p95 latency.
3. Returns `pass` if every threshold is met; `fail` otherwise.

`canary.evaluate()` ties the config and the gate together: hand it a
config plus a gate, and it runs the gate, then **auto-promotes** on pass
(re-pins the env to `toVersion`) or **auto-rolls-back** on fail (re-pins
to `fromVersion`) and audit-logs the regression reason:

```typescript
const result = await canary.evaluate(at10, {
  intervalMs: 30 * 60_000,
  gate: myGate,             // wraps regression-runner's gate()
});
// result.verdict: "pass" | "fail"
// result.action:  "promote" | "rollback"
```

The auto-rollback reverts the env's pin to the pre-canary version and
audits the reason — no partial cutover sticks.

For full automation, evaluate at each ramp step and stop on the first
failure (`evaluate()` has already rolled back by then):

```typescript
for (const step of [at10, at50, at100]) {
  const { verdict } = await canary.evaluate(step, { intervalMs, gate: myGate });
  if (verdict === "fail") break;
}
```

## A worked progression

```
T+0:    crewhaus spec put agent-name v3 ./new-spec.yaml       (CLI)
T+0:    route(config@1%, …) splits 1% of prod traffic to v3
T+30m:  evaluate(config@10%, { gate }) → pass → ramp to 10%
T+1h:   evaluate(config@50%, { gate }) → pass → ramp to 50%
T+2h:   evaluate(config@100%, { gate }) → pass → auto-promote (pin prod = v3)
```

Total: 2h gate-by-gate ramp on real prod traffic, with a
regression-runner backstop at each step. Failure at any step rolls
back.

## Observability of a canary in flight

Two key metrics, exposed by `canary-controller`:

| Metric                                   | What it shows                                       |
| ---------------------------------------- | --------------------------------------------------- |
| `canary_traffic_share`                    | Current weight (1, 10, 50, ...).                   |
| `canary_response_pass_rate{version=...}`  | Per-side pass rate from the eval grader.           |
| `canary_response_p95_latency{version=...}` | Per-side latency.                                  |

The Recipe 17 grafana panel includes these by default. A canary that
fails on either pass rate or latency should be visible **before** the
regression gate confirms it on the next check.

## Operational checklist

- **First-time setup.** `crewhaus init` scaffolds the project,
  including `.crewhaus/specs/` with an empty manifest.
- **Audit retention.** Deploy audit lives under `.crewhaus/audit/`
  (entries of kind `deployment_action`). Volume-mount in production.
- **Multi-environment.** Each environment (dev/staging/prod) has its
  own registry root; they don't share `manifest.json`. To promote
  cross-env, the deploy controller copies the version file too.
- **Deployment history.** Every promote/rollback/pin lands in
  `.crewhaus/audit/` as a `deployment_action` entry; replay that log
  to see who pinned what, when. Comparing the in-tree manifest with a
  running daemon's loaded spec is then a `jq` over the audit trail,
  not a deploy sub-verb.

## What to read next

- **Eval harness behind the gate.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Audit-logged promotions.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Kubernetes / Helm deployment.** [Recipe 24 — Docker and Helm](24-docker-and-helm.md).

## Pointers to source

- **Spec registry:** [`packages/spec-registry`](https://github.com/crewhaus/factory/blob/main/packages/spec-registry).
- **IR-passes:** [`packages/ir-passes`](https://github.com/crewhaus/factory/blob/main/packages/ir-passes).
- **Migration engine:** [`packages/migration-engine`](https://github.com/crewhaus/factory/blob/main/packages/migration-engine).
- **Migration runner:** [`packages/migration-runner`](https://github.com/crewhaus/factory/blob/main/packages/migration-runner).
- **Deployment controller:** [`packages/deployment-controller`](https://github.com/crewhaus/factory/blob/main/packages/deployment-controller).
- **Canary controller:** [`packages/canary-controller`](https://github.com/crewhaus/factory/blob/main/packages/canary-controller).
- **Regression runner:** [`packages/regression-runner`](https://github.com/crewhaus/factory/blob/main/packages/regression-runner).
- **Module catalog reference:** §28, §29 in [MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md).
