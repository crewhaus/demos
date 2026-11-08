# hello-managed

The smallest possible demonstration of the `target: managed` shape — a long-running JSON-RPC gateway daemon that serves two tenants with HS256-JWT auth, per-tenant budgets, hash-chained audit logs, and storage rebased per tenant.

## Run it

```bash
cd starters/managed          # if copied elsewhere, cd into that copy

# 1. Compile the spec to a gateway daemon.
bunx crewhaus compile crewhaus.yaml -o dist

# 2. Start the daemon. Binds to :3000 (override with PORT=...).
#    With no CREWHAUS_GATEWAY_JWT_SECRET set, it generates a signing secret
#    for this boot and saves it to .crewhaus/run/gateway-jwt-secret (0600).
bun install --cwd dist   # first run only — installs the bundle's @crewhaus deps
bun dist/daemon.ts
```

Set `CREWHAUS_GATEWAY_JWT_SECRET=<at least 16 chars>` ahead of time to keep tokens valid across restarts. A Claude credential (`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_API_KEY`) is required for the model to actually run.

Tenant data goes under `CREWHAUS_TENANTS_ROOT` (default `/tmp/crewhaus-tenants`). For a deployment, set it to an absolute path outside the harness directory, such as `~/.crewhaus/tenants/hello-managed`, so tenant data stays apart from the harness's own files.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile managed
bun run run managed
```

</details>

## Drive traffic

In a second terminal, from the same directory, mint a JWT for `tenant-a` with the daemon's signing secret and call `runs.create`:

```bash
# The secret this boot saved (or the CREWHAUS_GATEWAY_JWT_SECRET you set).
SECRET="$(cat .crewhaus/run/gateway-jwt-secret)"

# Mint a 1-hour JWT for tenant-a. The gateway reads the tenant from `tenant_id`.
TENANT_A_JWT=$(SECRET="$SECRET" bun --cwd dist -e 'import { signJwt } from "@crewhaus/gateway-server"; console.log(signJwt({ tenant_id: "tenant-a" }, process.env.SECRET))')

# Start a run.
curl -X POST http://localhost:3000/rpc \
  -H "Authorization: Bearer $TENANT_A_JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "runs.create",
    "params": { "input": "What is the capital of France?" }
  }'
# → { "jsonrpc":"2.0","id":1,"result":{ "runId":"run_...","status":"running" } }
```

Live-tail the run with `runs.subscribe` (SSE):

```bash
curl -N http://localhost:3000/rpc \
  -H "Authorization: Bearer $TENANT_A_JWT" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc":"2.0","id":2,"method":"runs.subscribe","params":{"runId":"run_..."} }'
```

## Inspect the audit log

Every JSON-RPC call lands in a tenant-scoped, hash-chained audit log under `$CREWHAUS_TENANTS_ROOT/<tenant-id>/audit/`:

```bash
TENANTS="${CREWHAUS_TENANTS_ROOT:-/tmp/crewhaus-tenants}"
ls "$TENANTS/tenant-a/audit/"
tail -f "$TENANTS/tenant-a/audit/$(date -u +%Y-%m-%d).jsonl"
```

A second tenant has an isolated audit dir (`.../tenant-b/audit/`) — cross-tenant reads are impossible by construction, which is the multi-tenant invariant `target: managed` exists to enforce.

## What this proves

This example is the smallest concrete proof that the managed gateway:

- Authenticates by tenant via HS256-JWT (`Authorization: Bearer ...`).
- Enforces a per-tenant token budget from `spec.tenants[].budget` (try setting `maxInputTokens: 100` to see the budget gate trip).
- Hash-chains the audit log so tampering is detectable.
- Rebase-isolates storage so `tenant-a` can never read `tenant-b`'s sessions.

See [`walkthroughs/11-managed-multitenant.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/11-managed-multitenant.md) for the full gateway protocol (`runs.continue`, `runs.cancel`, `sessions.fork`, `audit.tail`), policy hook integration, and SOC 2 evidence-export workflow.
