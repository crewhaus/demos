# hello-federation

Section 34 — sample federation deployment fixture.

This directory is **intentionally light**. Federation is the cross-deployment role-call protocol: production deployments compose the federation pieces themselves (mTLS certs, peer registries, traceparent propagation), so there is no `crewhaus.yaml` to compile — the runtime lives in the deployments, not in a bundled spec. The smoke is the demo.

## Run it

```bash
bun run smoke:section-34
```

Six probes exercise the federation surface end-to-end (no docker required, no live cross-host call):

1. Envelope round-trip + strict-version validation (v1 caller, v2 receiver fails closed).
2. Discovery cache with TTL.
3. Router happy path with an injected transport.
4. Error-classification taxonomy (retry / tombstone / fail).
5. In-process two-server demo over HTTP.
6. Docker-compose fixture (gated on `CREWHAUS_FEDERATION_LIVE=1`).

The full smoke source lives at [`smoke/section-34-federation-smoke/smoke.ts`](../../smoke/section-34-federation-smoke/smoke.ts).

## How production wires peers

There is **no `spec.federation.*` block** — the spec schema (`packages/spec/src/index.ts`) has no `federation` key, and `subAgentDefinitionSchema` is `.strict()`, so you can't add one. Federation is composed **programmatically**, exactly as the smoke's probes C and E do:

- The caller deployment (e.g. `deployment-a`, a researcher) constructs a router with `createFederationRouter({ fromDeployment, credentials })` and invokes `router.call({ fromRole, to: { deployment, role }, payload })`.
- The callee deployment (e.g. `deployment-b`, a code-reviewer) stands up its own HTTPS endpoint that `decodeFederationEnvelope`s the request body, runs the named role, and responds with `{ reply }`.

`credentials` is an `MtlsCredentials` value — PEM **strings** (`caCertPem`, `clientCertPem`, `clientKeyPem`) plus the peer's 64-char hex `pinnedFingerprint`, not file paths. Source them however your deployment supplies secrets; the walkthrough's router example reads them from env vars (`CREWHAUS_FED_CA_CERT`, `CREWHAUS_FED_CLIENT_CERT`, `CREWHAUS_FED_CLIENT_KEY`, `CREWHAUS_FED_PEER_FINGERPRINT`). Peers are discovered at call time via DNS SRV + `.well-known/crewhaus.json`, not declared in a spec.

See [`walkthroughs/27-federation.md`](../../walkthroughs/27-federation.md) for the envelope shape, mTLS pinning, traceparent propagation, and error-classification details.
