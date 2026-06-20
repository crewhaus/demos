# Recipe 22 — Compliance and Audit

Use the hash-chained audit log as the substrate for SOC 2 Type II,
ISO 27001, and HIPAA evidence collection. Define which audit records
prove which controls, run a periodic collector, and ship signed
evidence bundles to your auditor.

You'd reach for this when:

- You're shipping to **regulated customers** that ask for SOC 2 or ISO
  27001 attestation.
- You need to **prove**, not just claim, that "every tool call is
  audited and tamper-proof".
- You want to **automate** the evidence-collection step of an audit
  rather than chasing engineers for screenshots.

For internal-use agents with no compliance ask, none of this is
necessary — the audit log still records, but the collector and
evidence bundles are skippable.

## Prerequisites

- [Recipe 11 — Managed Multitenant](11-managed-multitenant.md) for
  the audit-log substrate.
- [Recipe 17 — Observability](17-observability.md) for the trace
  event taxonomy.

## Try it

The compliance-control collector + evidence-bundle pipeline is
exercised end-to-end by
[`smoke/section-39-compliance-controls-smoke/`](../smoke/section-39-compliance-controls-smoke).
Run `bun smoke/section-39-compliance-controls-smoke/smoke.ts` to
see the audit log mapped to SOC 2 CC controls, signed, and packaged
into an evidence tarball. The audit log itself is visible end-to-end
in [`starters/managed`](../starters/managed/README.md) under
`.crewhaus/starters/managed/<tenant>/audit/`.

## The audit log substrate

Each tenant gets one JSONL file per day under
`<base>/audit/<tenant>/<yyyy-mm-dd>.jsonl`. Permissions: `0o600`. Each
line is one event with a `prevHash` field forming an immutable chain.
Per-event data lives in an opaque `payload`; `seq` is a gapless 0-based
counter and `hash` commits to the whole body plus `prevHash`:

```json
{ "ts": 1747036800000, "version": 1, "kind": "policy_decision", "seq": 0, "payload": { "decision": "allow", "tool": "Bash" }, "prevHash": "GENESIS", "hash": "abc1..." }
{ "ts": 1747036801000, "version": 1, "kind": "tool_classification", "seq": 1, "payload": { "tool": "Bash", "class": "exec" }, "prevHash": "abc1...", "hash": "def4..." }
{ "ts": 1747036805000, "version": 1, "kind": "secrets_access", "seq": 2, "payload": { "secret": "DB_URL", "action": "read" }, "prevHash": "def4...", "hash": "0234..." }
```

Verify programmatically — the [`audit-log`](https://github.com/crewhaus/factory/blob/main/packages/audit-log)
package re-walks the chain stored under `.crewhaus/audit/<tenant>/`:

```typescript
import { verify } from "@crewhaus/audit-log";

const result = await verify(`.crewhaus/audit/${tenant}`);
```

It re-walks every event, recomputes `sha256(prev event)`, and reports
the first broken link if any. A clean log resolves to:

```
audit verified: 4823 events across 7 segments, no broken links
```

a tampered one to:

```
audit BROKEN at 2026-05-11/0042: expected prevHash abc1..., got def4...
```

A broken link is **proof of tampering**. The collector refuses to
build evidence bundles from a broken log.

## Control definitions

A `ControlDefinition` ties a framework requirement to audit-log
queries:

```typescript
{
  frameworkId: "soc2",
  controlId: "CC6.7",       // Restricted access to system functions
  description: "Restrict permitted actions; audit access and rotation.",
  // OR-merged: a record matching ANY filter is evidence for this control.
  evidenceQueries: [
    { kind: "secrets_rotation" },
    { kind: "secrets_access" },
  ],
}
```

Each entry in `evidenceQueries` is an `AuditEventFilter` — a structured
object, not a query string. Fields are AND-ed within one filter and the
filters are OR-merged across the array. The supported fields are `kind`,
`payloadField` / `payloadFieldEquals` (own-property reads on the record's
`payload`), and `tsAfter` / `tsBefore` (the `ts` bounds):

```typescript
// every secrets-manager rotation whose action was "rotate"
{
  kind: "secrets_rotation",
  payloadField: "action",
  payloadFieldEquals: "rotate",
}
```

Definitions live in [`packages/compliance-controls`](https://github.com/crewhaus/factory/blob/main/packages/compliance-controls).

## Built-in frameworks

Ships with definitions for:

| Framework      | Controls covered                                            |
| -------------- | ----------------------------------------------------------- |
| SOC 2 Type II  | CC6.1 (logical access), CC6.7 (restricted access to system functions), CC7.2 (anomaly detection), CC7.3 (response) |
| ISO 27001      | A.12.4 (logging)                                             |
| HIPAA          | 164.312(b) (audit controls)                                  |

These are starting points — your auditor may map controls differently.
Add custom definitions in code with `collector.registerControl(def)`:

```typescript
collector.registerControl({
  frameworkId: "soc2",
  controlId: "CC6.8",
  description: "Custom control — captured deployment actions.",
  evidenceQueries: [{ kind: "deployment_action" }],
});
```

## The evidence collector

```bash
crewhaus compliance evidence --framework soc2 --period 2026-Q2
```

Walks every audited tenant for every SOC 2 control. For each control,
runs the `evidenceQueries` against the audit log, and produces:

```
.crewhaus/compliance/soc2/CC6.1/2026-Q2.json
.crewhaus/compliance/soc2/CC6.7/2026-Q2.json
.crewhaus/compliance/soc2/CC7.2/2026-Q2.json
.crewhaus/compliance/soc2/CC7.3/2026-Q2.json
```

Each `EvidenceBundle` JSON file:

```json
{
  "frameworkId": "soc2",
  "controlId": "CC6.7",
  "description": "Restricted access to system functions — secrets-manager rotation + access events captured.",
  "period": "2026-Q2",
  "generatedAt": 1751328000000,
  "recordCount": 142,
  "records": [/* every matching audit record, verbatim */],
  "digest": "<hex SHA-256 of the canonical record list>",
  "signature": "<hex HMAC of digest under signing key, or null when unsigned>"
}
```

The bundle is **self-verifying** — `verifyBundle(bundle, signingKey)` in
[`compliance-controls`](https://github.com/crewhaus/factory/blob/main/packages/compliance-controls)
re-checks it before it's trusted:

1. Recompute `digest` over the bundle's `records` and compare it to the
   `digest` field (catches a payload rewrite after signing).
2. Re-check every record's body↔hash consistency.
3. When a signing key is supplied, re-derive the HMAC and compare it to
   `signature` in constant time.

If any step fails, the bundle is rejected as tampered.

## Producing a bundle

```bash
crewhaus compliance evidence \
  --framework soc2 \
  --period 2026-Q2 \
  --control CC6.7 \
  --audit-dir .crewhaus/audit \
  --signing-key-env COMPLIANCE_SIGNING_KEY
```

Flags:

| Flag                  | Default                | Purpose                                              |
| --------------------- | ---------------------- | ---------------------------------------------------- |
| `--framework`         | required               | `soc2`, `iso27001`, `hipaa`, or custom.              |
| `--period`            | required               | Time-bucket label (e.g. `2026-Q2`, `2026-05`).        |
| `--control`           | all                    | Restrict to one control id.                          |
| `--audit-dir`         | `.crewhaus/audit`      | Where to read audit logs.                            |
| `--signing-key-env`   | unset (no signature)   | Env var holding the HMAC signing key.                 |
| `--out-dir`           | `.crewhaus/compliance` | Where to write bundles.                              |

Names (`framework`, `control`, `period`) are validated against
`^[A-Za-z0-9_.-]+$` to prevent path-traversal — `../etc/passwd` and
friends are rejected.

## A worked quarterly cycle

```
T+0:        Quarter starts.
T+90d:      Quarter ends.
T+91d:      crewhaus compliance evidence --framework soc2 --period 2026-Q2
T+91d:      bundles written to .crewhaus/compliance/soc2/{CC6.1,CC6.7,CC7.2,CC7.3}/2026-Q2.json
T+92d:      Manual review of bundles for completeness.
T+95d:      Bundle handed to auditor (signed by your COMPLIANCE_SIGNING_KEY).
T+120d:     Auditor verifies bundles and either signs off or asks follow-up questions.
```

The runtime is one piece; the human review and auditor handoff are
the other pieces. Don't skip the review step — the collector tells
you **what evidence exists**; the human decides **whether the evidence
proves the control**.

## Path-traversal refusal

Every name argument is validated. Examples that get rejected:

```bash
crewhaus compliance evidence --framework ../etc --period 2026-Q2
# → error: framework name must match /^[A-Za-z0-9_.-]+$/

crewhaus compliance evidence --framework soc2 --period 2026-Q2/.. \
  --out-dir /tmp
# → error: period contains path-traversal characters
```

So a malicious or buggy CI script can't trick the collector into
overwriting an unrelated file.

## Data retention

The `data-retention-engine` default is **90 days** (`defaultRetentionDays`);
multi-year retention is not the default — it's an explicit per-kind choice
you make with `retain(...)`. Pin audit records for as long as your
framework requires before the sweeper can reclaim them. Records inside an
active audit window are never reclaimed regardless of policy, so in-flight
evidence collection isn't disrupted. To rotate older data, archive offline
or move to compliant cold storage.

To enforce and inspect retention, use the
[`data-retention-engine`](https://github.com/crewhaus/factory/blob/main/packages/data-retention-engine)
programmatically:

```typescript
import { createDataRetentionEngine } from "@crewhaus/data-retention-engine";

const engine = createDataRetentionEngine({ recordStore });
// Default window is 90 days; pin audit records for 7 years explicitly.
engine.retain(tenant, "policy_decision", 2555);
engine.listRetention();                 // the configured per-tenant / per-kind policies
const result = await engine.sweep();    // walk all records, delete anything past its window
```

`sweep()` skips any record inside an active audit window and deletes the
rest; `listRetention()` / `listAuditWindows()` expose the configured
policies so you can confirm each tenant has one. A tenant missing a
policy needs either a documented policy added or older segments restored
from backup.

## Things that look like audit but aren't

| Symptom                                                          | Better tool                                       |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| Want per-event metric (count, latency, cost).                    | [`trace-event-bus`](https://github.com/crewhaus/factory/blob/main/packages/trace-event-bus) + OTel exporter |
| Want a free-form search over events.                             | Pipe audit JSONL into Loki/Splunk/Elastic.        |
| Want to redact PII before audit captures it.                     | [Recipe 23 — PII Redaction](23-pii-redaction-and-encryption.md). |
| Want tamper-proof but **not** chain-verifiable.                  | Audit log + WORM storage (S3 Object Lock).        |

The audit log is **comprehensive, immutable, tenant-scoped, and
verifiable**. It's not a search engine — Splunk or Loki is.

## What to read next

- **PII inside audit payloads.** [Recipe 23 — PII Redaction and Encryption](23-pii-redaction-and-encryption.md).
- **Audit promotions and rollbacks.** [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md).
- **The trace event substrate.** [Recipe 17 — Observability](17-observability.md).

## Pointers to source

- **Audit log:** [`packages/audit-log`](https://github.com/crewhaus/factory/blob/main/packages/audit-log).
- **Compliance controls:** [`packages/compliance-controls`](https://github.com/crewhaus/factory/blob/main/packages/compliance-controls).
- **Module catalog reference:** §20 (audit-log), §39 (compliance-controls) in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
