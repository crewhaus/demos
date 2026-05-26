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

The full smoke source lives at [`examples/section-34-federation-smoke/smoke.ts`](../examples/section-34-federation-smoke/smoke.ts).

## Inputs (for production deployments)

Production wires these in `spec.federation.peers`:

- `deployment-a` (caller) — researcher agent. mTLS cert at `~/.crewhaus/federation/deployment-a/{cert,key}.pem`.
- `deployment-b` (callee) — code-reviewer agent. mTLS cert at `~/.crewhaus/federation/deployment-b/{cert,key}.pem`.

See [`walkthroughs/27-federation.md`](../../walkthroughs/27-federation.md) for the envelope shape, mTLS pinning, traceparent propagation, and error-classification details.
