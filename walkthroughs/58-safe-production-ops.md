# Recipe 58 — Safe production ops

**Catalog modules:** `canary-controller`, `regression-runner`, `deployment-controller`, `spec-registry`, `slo-monitor`, `mcp-host`, `alert-watchdog`, `incident-collector`.
**Shipped:** crewhaus 0.2.0 (`crewhaus deploy canary`, `observability.slo`, `eval --sentinel`, `crewhaus mcp doctor`).

[Recipe 21 — Deployment and Canary](21-deployment-and-canary.md)
described the canary controller as *programmatic only* — "there's no
CLI verb; you instantiate the controller." That's no longer true.
0.2.0 shipped `crewhaus deploy canary`: the verb that finally wires the
caller-less controller to a real `regression-runner.gate()`, plus three
more production-ops surfaces — a spec `observability.slo` block that
self-mitigates on sustained breach, `eval --sentinel` to catch a
provider drifting under you, and `crewhaus mcp doctor` to score MCP
server health.

You'd reach for this when:

- You need to **swap a spec version in production** and want the swap
  gated on a real eval, with automatic rollback if it regresses.
- You want the runtime to **react to a sustained SLO breach on its own**
  — alert, then pause intake, then roll back — instead of paging you.
- You depend on **MCP servers** and want their health, schema drift,
  and quarantine state visible.

## Prerequisites

- [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md) for
  the spec registry, env pins, and the deployment controller the canary
  verb drives.
- [Recipe 12 — Eval Harness](12-eval-harness.md) for the dataset +
  graders behind the gate.

## Eval-gated canary with auto-rollback

`crewhaus deploy canary <spec.yaml> <version>` registers the candidate
version, then drives a traffic ramp. At each step it evals **both** the
baseline and the candidate against the same dataset + graders and feeds
the two results into the real regression gate. Pass at every step →
the env pin auto-promotes to the candidate. First failing step →
auto-rollback to the baseline, and the ramp stops. Every promote and
rollback is audit-logged (`deployment_action`).

```bash
crewhaus deploy canary crewhaus.yaml v4 \
  --traffic 5,25,50,100 \
  --dataset registry:support-agent-ratings \
  --graders eval/graders.yaml \
  --from v3 \
  --env prod \
  --max-pass-rate-drop 0.05 \
  --max-p95-latency-ms 5000
```

The flags:

| Flag                     | Meaning                                                    | Default              |
| ------------------------ | ---------------------------------------------------------- | -------------------- |
| `--traffic`              | strictly-increasing ramp steps                             | `5,25,50,100`        |
| `--dataset`              | eval dataset: a file path or `registry:<name>[@ver][#split]` | —                  |
| `--graders`              | grader config                                              | —                    |
| `--from`                 | baseline version                                           | the env's current pin |
| `--env`                  | env pin to promote / roll back                             | `prod`               |
| `--name`                 | registry spec name                                         | the spec's own name  |
| `--max-pass-rate-drop`   | gate: max pass-rate drop before fail                       | `0.05`               |
| `--max-p95-latency-ms`   | gate: max p95 latency rise (ms) before fail                | `5000`               |
| `--concurrency` / `--seed` / `--judge-model` | eval knobs, as `crewhaus eval`         | —                    |

> **Traffic-split caveat (v1).** `crewhaus eval` runs `target: cli`,
> and the canary controller's `route()` has no serving-path consumer,
> so the ramp percentages gate eval **sampling and promotion
> confidence**, not a live request-level traffic split. Each step evals
> the full dataset against both versions; the percentages sequence the
> confidence ramp. A real per-request split matters only for
> gateway/managed shapes with a serving-path `route()` consumer — out
> of scope for `target: cli` here.

This is the headline use for a safe production **model swap**: pair it
with the model-benchmark matrix (`eval --models a,b,c`) from
[Recipe 59 — Model resilience & cost](59-model-resilience-and-cost.md)
to pick the candidate, then canary it into prod behind the gate.

## The `observability.slo` block — self-mitigation on breach

Declare production Service-Level Objectives in the spec and the runtime
SLO monitor folds bus events into rolling windows and walks a
**mitigation ladder** on a *sustained* breach. A single blip never
fires — the breach must persist across `window_seconds`.

```yaml
name: support-agent
target: cli
version: 1
agent:
  model: claude-sonnet-5
  instructions: |
    Answer the user's support question. Cite the doc you used.
tools: []
observability:
  slo:
    error_rate: 0.05
    p95_latency_ms: 4000
    ttft_ms: 800
    cost_per_hour_usd: 10
    window_seconds: 300
    mitigation:
      - alert
      - pause-intake
      - rollback
```

Every target is optional — declare only the SLOs you care about (the
block requires at least one). The ladder rungs execute in declared
order on a sustained breach, each at most once per session:

| Rung           | What it does                                                            | Safety   |
| -------------- | ---------------------------------------------------------------------- | -------- |
| `alert`        | fire a webhook / hook                                                   | always safe |
| `pause-intake` | reuse the gateway/managed 429 `budget_exceeded` path to stop new work  | opt-in — touches traffic |
| `rollback`     | auto-rollback the env pin via the deployment controller                | opt-in — touches deploys |

`alert` is the default when `mitigation` is omitted (observe-only is
safe). The higher rungs are opt-in because they touch traffic and
deploys — a spec must ask for them explicitly. Every rung is
audit-logged.

The `ttft_ms` target has a matching doctor probe you can run in a
container HEALTHCHECK — it compares recent p95 TTFT against
`observability.slo.ttft_ms` and names faster candidates on a breach:

```bash
crewhaus doctor --slo    # exit 0 within budget / no data; exit 1 on breach
```

## `eval --sentinel` — catch a drifting provider

Your spec didn't change. Your dataset didn't change. Scores dropped
anyway. That's the **provider** drifting under you — a model update, a
silent quantization. `eval --sentinel` catches it: re-run a
seed-pinned dataset against the unchanged spec and diff against a
frozen baseline run. When `specHash` and the dataset hash are both
unchanged but scores shifted, it exits non-zero.

```bash
crewhaus eval crewhaus.yaml \
  --dataset registry:support-agent-ratings \
  --graders eval/graders.yaml \
  --sentinel \
  --baseline .crewhaus/evals/run-2026-07-01T00-00-00Z \
  --seed 42
```

Run it on a nightly cron; a non-zero exit is your signal that the model
changed even though your code didn't. Pair it with the model market
scan in [Recipe 59](59-model-resilience-and-cost.md) to find a
replacement.

## `crewhaus mcp doctor` — MCP server health

If your agent depends on MCP servers (Recipe 13), their health is part
of your production surface. `crewhaus mcp doctor` scores each server
from recent sessions — connection success, tool-call error rate,
latency — and, with `--probe`, does a live `listTools` call to watch
for tool-schema drift and decide runtime quarantine:

```bash
crewhaus mcp doctor                       # score from the last 20 sessions
crewhaus mcp doctor --probe               # + live listTools drift watch
crewhaus mcp doctor --probe --format json # machine-readable for a dashboard
```

A server whose tool schema drifted from what the harness compiled
against is a common silent break — a renamed tool argument that turns
every call into an error. The drift watch surfaces it before it becomes
a support ticket.

## When something breaks: `incident collect`

When a session failed and you need the full picture in one bundle —
traces, audit entries, cost accrual, and a doctor snapshot —
`crewhaus incident collect` assembles it:

```bash
crewhaus incident collect --session sess_0a1b2c3d4e5f6789 \
  --kind regression --reason "canary rollback at 25%"
```

The 0.2.0 alert watchdog can also auto-assemble these bundles from
traces on failure events, so a paged on-call starts from a complete
bundle instead of grepping logs.

## Putting it together — a production posture

```
nightly:   eval --sentinel        → provider drift alarm
nightly:   flywheel run (Recipe 56) → PR with an improved spec
on merge:  deploy canary v_new     → eval-gated ramp, auto-rollback on regress
always-on: observability.slo       → self-mitigate sustained breaches
always-on: mcp doctor (dashboard)  → MCP health + drift
on failure: incident collect       → one bundle for the on-call
```

Each piece is independent; adopt them in any order. The sentinel and
`mcp doctor` are pure reads you can add today; the SLO block and canary
verb change what production *does* on breach and on deploy.

## What to read next

- **Registry, env pins, and the deployment controller.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **Picking the candidate to canary.** [Recipe 59 — Model resilience & cost](59-model-resilience-and-cost.md).
- **The dataset + graders behind every gate.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **MCP servers.** [Recipe 13 — MCP Servers](13-mcp-servers.md).

## Pointers to source

- **Canary controller:** [`packages/canary-controller`](https://github.com/crewhaus/factory/blob/main/packages/canary-controller).
- **Regression gate:** [`packages/regression-runner`](https://github.com/crewhaus/factory/blob/main/packages/regression-runner).
- **Deployment controller:** [`packages/deployment-controller`](https://github.com/crewhaus/factory/blob/main/packages/deployment-controller).
- **Spec registry:** [`packages/spec-registry`](https://github.com/crewhaus/factory/blob/main/packages/spec-registry).
- **Module catalog reference:** §28, §29, §37 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
