# Recipe 27 — Federation

Make a sub-agent call across deployment boundaries. Agent A in your
deployment can transparently call role X in deployment B over mTLS,
with cert pinning, version-locked envelopes, traceparent propagation
so OpenTelemetry stitches one trace across both, and a recovery
taxonomy that classifies federation errors as retry / tombstone / fail.

You'd reach for federation when:

- Roles need to run on **different hosts** for security, geographic,
  or organizational reasons.
- You're integrating with **another team's agent** that's deployed
  separately.
- You want a **trust boundary** between roles — cert pinning ensures
  Deployment B can verify Deployment A.

For roles in the same deployment, use [crew](04-multi-agent-crew.md).
For isolated children that share no context, use [sub-agents](28-sub-agents-and-task.md).
Federation is **crew handoff that crosses a deployment boundary**.

> **Status:** federation ships today as libraries + a `crewhaus
> federation discover` CLI verb + a smoke fixture, but it is **not yet
> wired into the `crewhaus.yaml` spec**. You compose the packages
> directly in deployment code — there is no `federation` field you can
> add to a spec to make an agent federate out. See
> [Spec integration (not yet wired)](#spec-integration-not-yet-wired)
> below.

## Prerequisites

- [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md) — federation
  is the cross-host version.
- A second deployment (or a docker-compose fixture) to call out to.

## The federation envelope

The bytes on the wire:

```json
{
  "version": "crewhaus.federation.v1",
  "traceparent": "00-abc123...-def456-01",
  "kind": "question",
  "payload": "Review this diff: ...",
  "federation": {
    "from": { "deployment": "deployment-a", "role": "researcher" },
    "to": { "deployment": "deployment-b", "role": "code-reviewer" },
    "mtls": {
      "client_cert_subject": "CN=deployment-a, O=crewhaus"
    }
  }
}
```

`kind` is the A2A envelope kind — `question | answer | notify` (mirroring
`@crewhaus/a2a-protocol`); a cross-host role-call is a `question`. The
caller/callee identities live **only** inside `federation.from` / `federation.to`
as `{ deployment, role }` pairs — there are no top-level `from`/`fromRole`
fields.

The `version` field is **strict** — receiver requires exact match.
Version mismatch (e.g. v1 caller, v2 receiver) fails closed. This
forces a deliberate dual-deploy when the protocol changes; there is
no silent fallback.

## Transport: mTLS over HTTPS

Federation uses standard HTTPS POST with **mutual TLS**:

- **Caller** presents its client cert when initiating the connection.
- **Receiver** presents its server cert.
- Both **pin** the other's leaf certificate (not just chain validity).

### Credential validation

Before the network call, `validateCredentials()` walks the local
credentials:

1. PEM shape matches `-----BEGIN CERTIFICATE-----` (CA + client cert)
   and a recognized private-key header.
2. The client cert + key parse successfully.
3. Cert's `validTo` (`notAfter`) is in the future.
4. `pinnedFingerprint` is a 64-char hex SHA256.

Any of these failing aborts the call **before** the network round-trip.
So a missing or expired client cert produces a clear local error
rather than a confusing TLS error from the peer.

### Cert pinning

The pin is checked in `https.request`'s `checkServerIdentity`
callback:

```typescript
checkServerIdentity: (_host, cert) => {
  const fp = cert.fingerprint256?.replaceAll(":", "").toLowerCase() ?? "";
  if (fp !== creds.pinnedFingerprint) {
    return new Error(`cert-pin mismatch: peer fingerprint ${fp} != pinned ${creds.pinnedFingerprint}`);
  }
  return undefined;
}
```

Any other cert (even one chaining to the same CA) is rejected. This
catches:

- A new cert issued by your CA to an attacker who compromised the CA.
- A man-in-the-middle with a different but valid cert.
- A cert rotation that didn't go through the pin-update workflow.

Pin updates require a deliberate config change. There is no
automatic rotation that "just works" — the operator must
deliberately accept the new fingerprint.

## Discovery

How does Deployment A find Deployment B's URL + fingerprint?
`discoverDeployment(deployment, opts)` chains:

1. **DNS SRV.** Look up `_crewhaus._tcp.<deployment>.<domain>`.
   Returns `host:port`.
2. **`.well-known/crewhaus.json`.** Fetch
   `https://<host>:<port>/.well-known/crewhaus.json`, which returns a
   `PeerRecord`:

   ```json
   {
     "endpoint": "https://<host>:<port>",
     "version": "crewhaus.federation.v1",
     "supportedShapes": ["code-reviewer", "researcher"],
     "publicKeyFingerprint": "abc...<64-char hex>"
   }
   ```

   `publicKeyFingerprint` must be exactly 64 hex chars (the SHA256 of the
   peer's leaf cert, no `:` separators); `endpoint` must be `https://`
   (loopback `http://` is allowed only for test fixtures). The discovery
   layer also accepts `snake_case` aliases (`supported_shapes`,
   `public_key_fingerprint`).

3. The router pins the peer's actual TLS leaf-cert fingerprint against
   this `publicKeyFingerprint` (see "The router" below) before any reply
   is trusted.

### TTL caching

Successful discoveries cache for the SRV record's TTL when available,
else 60 seconds; negative responses (SRV not found, well-known 404)
cache for 10 seconds (the `negativeTtlMs` default). Without this, a
misconfigured peer would trigger a DNS storm under load.

`crewhaus federation discover <deployment> [--srv-domain <d>] [--format json|yaml]`
from the CLI resolves and prints the `PeerRecord` (JSON by default):

```json
{
  "endpoint": "https://bot-b.example.com:8443",
  "version": "crewhaus.federation.v1",
  "supportedShapes": ["code-reviewer"],
  "publicKeyFingerprint": "abc...<64-char hex>"
}
```

`discover` is the **only** `federation` subcommand the CLI exposes.

## The router — making a call

```typescript
const router = createFederationRouter({
  fromDeployment: "deployment-a",
  // MtlsCredentials: PEM strings + the peer's pinned leaf fingerprint.
  credentials: {
    caCertPem: process.env.CREWHAUS_FED_CA_CERT,
    clientCertPem: process.env.CREWHAUS_FED_CLIENT_CERT,
    clientKeyPem: process.env.CREWHAUS_FED_CLIENT_KEY,
    pinnedFingerprint: process.env.CREWHAUS_FED_PEER_FINGERPRINT, // 64-char hex
  },
  // Optional: a shared long-lived `discovery`, a `currentTraceparent()`
  // bound to the bus span, and a per-run `runContext` (boundary tagging).
});

const result = await router.call({
  fromRole: "researcher",
  to: { deployment: "deployment-b", role: "code-reviewer" },
  payload: "Review the diff for SQL injection.",
  kind: "question",
});

console.log(result.reply);
```

What happens:

1. Validate local credentials.
2. Discover deployment-b (with cache).
3. Assert the discovered `publicKeyFingerprint` matches the configured
   `credentials.pinnedFingerprint`.
4. Build the envelope (with the caller's traceparent).
5. POST over mTLS, with the peer's leaf cert pinned in
   `checkServerIdentity`.
6. Decode `{ reply }` from the response, then classify it (see
   "Boundary classification" below).

The router emits `RouterTraceEvent`s around the call
(`federation_call_start`, then `federation_call_end` with `status` +
`durationMs`, or `federation_call_error` with the error message);
subscribe via `router.subscribe(listener)`. Wire these into your
exporter so OpenTelemetry shows the cross-deployment flow in one trace.

## traceparent propagation

The W3C `traceparent` header propagates through the envelope's
`traceparent` field. When deployment-b receives the call, it picks
up the trace context and emits its spans as children of the caller's
span. The resulting trace shows:

```
deployment-a: agent run
└─ deployment-a: federation call to deployment-b
   └─ deployment-b: role activation (code-reviewer)
      └─ deployment-b: tool call (Read)
      └─ deployment-b: tool call (Grep)
```

One trace, two deployments. Both deployments need OTel exporters
pointing at the same Jaeger / Tempo backend for the trace to render
as a unified tree.

## Error classification

`classifyRouterError(err)` (in `@crewhaus/federation-router`) maps a
caught error to a `RecoveryHint` the runtime acts on:

| Error                                    | Class       | Action                                            |
| ---------------------------------------- | ----------- | ------------------------------------------------- |
| Network error / timeout                  | `retry`     | Re-call after exponential backoff (`delayMs` ~1s). |
| TLS error (cert-pin / fingerprint mismatch, expired, wrong CA) | `tombstone` | Surface a clear auth-failure; retry won't help until certs are fixed. |
| 5xx from peer                            | `retry`     | Re-call after backoff (`delayMs` ~2s).            |
| 4xx from peer (auth, bad request)        | `tombstone` | Caller error; retry won't help.                   |
| Unknown                                  | `fail`      | Surface the error; let the agent handle it.       |

A `tombstone` hint is a return value (`{ kind: "tombstone", reason }`) —
the recovery taxonomy, not a persisted peer-state file. There is no
`federation tombstone` CLI verb; `federation` only does `discover`. To
recover from an auth tombstone you fix the underlying cause (re-pin the
peer's fingerprint, renew the cert) and call again.

## Spec integration (not yet wired)

> **Forward-looking.** Federation ships today as a set of libraries
> (`federation-protocol`, `federation-discovery`, `federation-router`)
> plus the `crewhaus federation discover` CLI verb and the
> `smoke:section-34` fixture. It is **not** wired into the
> `crewhaus.yaml` spec → compile → runtime path: the spec schema
> (`packages/spec/src/index.ts`) has no `federation` block, the
> `subAgents` definition has no `federation` field, there is no
> `FederationCall` agent tool in the tool catalog (`federationCall` is a
> transport function in `federation-protocol`, not a tool an agent can
> list), and the
> `channels` block accepts only `slack | telegram | discord | whatsapp
> | imessage` — there is no `channels.federation`. So there is no spec
> fragment you can compile to make an agent federate out today.

How you use it now: production deployments compose the federation
packages directly. A deployment that federates out constructs a
`createFederationRouter({ fromDeployment, credentials })` and invokes
`router.call(...)` from its own code (see "The router" above); a
deployment that receives federated calls stands up its own HTTPS
endpoint that `decodeFederationEnvelope`s the request body, runs the
named role, and responds with `{ reply }`. The `starters/federation`
fixture is intentionally light for exactly this reason — there is no
bundled spec; the smoke is the demo.

A future release may surface federation through the spec (e.g. a
`subAgents[name].federation: { deployment, role }` field so a `Task` /
`SendMessage` call routes through the federation-router instead of the
local sub-agent spawner). That wiring does not exist yet — treat any
`spec.federation.*` snippet as aspirational until the spec schema
gains the field.

## A two-deployment fixture

```bash
bun run smoke:section-34
```

The smoke exercises the federation surface end-to-end with six probes
(no Docker required for the first five):

1. **A** — envelope encode/decode round-trip + strict version validation
   (a v2 receiver fails closed on a v1 caller).
2. **B** — `federation-discovery` `.well-known` happy path with TTL
   caching.
3. **C** — `federation-router` happy path with an injected transport:
   envelope shape, fingerprint pin check, traceparent propagation.
4. **D** — router error mapping → recovery taxonomy
   (`classifyRouterError`).
5. **E** — a live in-process two-deployment demo: a `Bun.serve` peer
   that `decodeFederationEnvelope`s the request and echoes a `{ reply }`,
   with the router pointed at it via an injected transport (plain HTTP —
   mTLS verification is shimmed away for the smoke), confirming a full
   `router.call` round-trip lands the payload and returns the reply.
6. **F** — a docker-compose two-deployment probe, gated behind
   `CREWHAUS_FEDERATION_LIVE=1` and skipped on plain CI.

See [`starters/federation/README.md`](../starters/federation/README.md)
for the fixture layout.

## Boundary classification

Every federated call's `reply` is **untrusted external content**.
The router classifies it on the calling side, in
[`packages/federation-router/src/index.ts`](../../factory/packages/federation-router/src/index.ts)
`call()`: right after the response body is decoded and the `reply`
field validated — and strictly *after* the mTLS / cert-pin / version
checks have authenticated *who* the peer is — it runs
`classifyBoundary(reply, { origin: "federation" })` before the reply
is returned into deployment-a's model context
([Recipe 41 — Security Fabric](41-security-fabric.md)).

On a malicious verdict (origin `"federation"` defaults to `block`)
the raw reply is replaced by a redaction notice; on a pass/warn
verdict the reply is returned verbatim and, when the caller threaded
a `RunContext` into the router config, tagged into
`runContext.dataLineage` under `"federation"` so the egress fabric
sees it on any later external-tool call.

A malicious deployment-b therefore can't slip prompt injections into
deployment-a's model context without the classifier seeing them —
authentication proves the envelope came from the pinned peer, but the
content is screened independently of who sent it.

## Operational checklist

- **Treat the pinned fingerprint as security config.** The peer's
  `pinnedFingerprint` (sourced however your deployment supplies
  `credentials` — env, secret store, a committed config) belongs under
  review like any security-sensitive value; a pin change is a trust
  change.
- **Rotate certs deliberately.** Two-week notice; coordinated; every
  caller updates the peer's `pinnedFingerprint` in lockstep with the
  rotation.
- **Tombstones page.** A tombstone is a security signal — page when
  one fires, even if the system is otherwise healthy.
- **Watch call latency.** The router's `federation_call_end` trace
  event carries a `durationMs`; chart its p95. Cross-deployment calls
  are slower than in-process, so a regression suggests routing issues.

## Things that look like federation but aren't

| Symptom                                                              | Better tool                                       |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Roles in the same deployment.                                        | [Crew](04-multi-agent-crew.md)                    |
| Need an isolated child that can't see parent context.                | [Sub-agents](28-sub-agents-and-task.md)           |
| Need to call an arbitrary HTTP service.                               | A `Fetch` tool with the right allow-list           |
| Need to deploy across regions for **latency**, not security.         | A regional load balancer in front of one deployment |

## What to read next

- **Crew (the in-deployment version).** [Recipe 04 — Multi-Agent Crew](04-multi-agent-crew.md).
- **Multi-tenant gateways behind federation.** [Recipe 11 — Managed Multitenant](11-managed-multitenant.md).
- **Audit trails of federated calls.** [Recipe 22 — Compliance and Audit](22-compliance-and-audit.md).
- **Trust-boundary classification.** [Recipe 41 — Security Fabric](41-security-fabric.md).

## Pointers to source

- **Protocol:** [`packages/federation-protocol`](https://github.com/crewhaus/factory/blob/main/packages/federation-protocol).
- **Discovery:** [`packages/federation-discovery`](https://github.com/crewhaus/factory/blob/main/packages/federation-discovery).
- **Router:** [`packages/federation-router`](https://github.com/crewhaus/factory/blob/main/packages/federation-router).
- **Fixture:** [`starters/federation/README.md`](../starters/federation/README.md).
- **Module catalog reference:** §34 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
