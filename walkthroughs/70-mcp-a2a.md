# Recipe 70 — Making a CrewHaus agent consumable: MCP server + A2A

**Pillar:** Batch G — the *interoperate* half of the loop: an agent isn't only
something you run, it's something other runtimes call.
**Shipped:** crewhaus 0.4.0 (`serve --mcp`, the `expose:` block,
`@crewhaus/mcp-server`, `@crewhaus/federation-protocol`, the
`sub_agents.<name>.federation` key).

Every recipe so far treats your agent as the thing at the top of the stack — you
`run` it, `serve` it a web UI, point a channel at it. This one turns the arrow
around. A 0.4.0 bundle can be **consumed by other software**: projected as an
**MCP server** so Claude Code or an IDE calls it as a tool, and published as an
**A2A peer** with a real Agent Card so another deployment federates to it.

Two seams do this, and they don't overlap:

- **`expose:` / `crewhaus serve --mcp`** makes your agent a **tool** a model
  can call — one turn in, final reply out.
- **A2A federation** (the Agent Card at `/.well-known/agent-card.json` plus the
  `sub_agents.<name>.federation.url` key) makes your agent a **peer** another
  deployment routes a `Task` to.

You'd reach for these when:

- You want your support agent available **inside Claude Code / an IDE** as just
  another MCP tool, without writing a bespoke MCP server.
- Another team runs an agent you want your agent to **delegate to** across a
  deployment boundary, discovered by a standard Agent Card rather than a
  hand-shared URL.
- You're composing a **mesh** of specialised agents and want each one both
  callable-as-a-tool and discoverable-as-a-peer.

## Prerequisites

- [Recipe 28 — Sub-agents & Task](28-sub-agents-and-task.md) for the local
  `sub_agents` model that the `federation.url` key extends across a boundary.
- [Recipe 27 — Federation](27-federation.md) for the wire-level envelope, mTLS
  pinning, and error taxonomy underneath the Agent Card. Recipe 27 composes
  those packages in deployment code; this recipe covers the **spec-level**
  wiring 0.4.0 added on top.

## `crewhaus serve --mcp` — your agent as an MCP tool

The fastest path. Point `serve --mcp` at any `target: cli` spec and it projects
the agent's turn function — the *same* interpreter `crewhaus run` drives — as an
MCP server. No `expose:` block required; absent one it defaults to **stdio**
transport and a single **`chat`** tool:

```bash
# stdio MCP server on stdin/stdout — one `chat` tool taking { message }.
crewhaus serve --mcp starters/cli/crewhaus.yaml
```

That's the shape Claude Code / an IDE spawns: register the command as a stdio
MCP server and the agent shows up as a `chat` tool whose one argument is
`message`, returning the agent's final assistant text. `--model`,
`--permission-mode`, and `--plugins` thread through exactly as on `crewhaus run`.

To serve it over the network instead of stdio, pass `--sse` — a Web-Standard
Streamable-HTTP endpoint on `--port` (default `8000`, or `CREWHAUS_MCP_PORT`):

```bash
crewhaus serve --mcp starters/cli/crewhaus.yaml --sse --port 8000
```

> **Only `target: cli` projects through `serve`.** It reuses the cli
> interpreter turn function. A `channel` or `managed` daemon carries the same
> `expose` in its IR but **self-exposes from its own gateway `fetch` path**, not
> through `serve` — point `serve --mcp` at one and you get a clear error naming
> the supported target.

## The `expose:` block — bake the projection into the bundle

`serve --mcp` reads flags; the `expose:` block records the same decisions **in
the spec** so a compiled bundle exposes itself the same way every time (and so
`channel`/`managed` daemons know to self-expose). It carries one nested `mcp`
object:

```yaml
name: support
target: cli
agent:
  model: claude-sonnet-5
  instructions: |
    You are the support agent. Answer product questions concisely.
expose:
  mcp:
    transport: sse        # stdio (default) or sse
    tools: chat           # chat (default) or per-subagent
```

- **`transport`** — `stdio` (what `serve --mcp` spawns by default) or `sse`
  (the HTTP endpoint). The `--sse` flag **overrides** the block, so you can
  force SSE over a `stdio` spec without editing it.
- **`tools`** — `chat` (default: one primary tool for the whole agent) or
  `per-subagent`, which registers that primary `chat` tool **plus one tool per
  declared sub-agent**, each sanitised to an MCP-safe name and routed back to
  the real sub-agent.

Omit `expose:` entirely and the bundle is byte-identical to a pre-0.4.0 build —
nothing is exposed unless you ask.

`per-subagent` needs sub-agents to project, and the spec's cross-field
validation enforces it — this fails to compile, it doesn't ship a half-wired
server:

```yaml
expose:
  mcp:
    tools: per-subagent   # ERROR if agent.sub_agents is empty:
    # expose.mcp.tools: "per-subagent" projects each sub-agent as its own MCP
    # tool, but the cli shape declares no sub_agents — use tools: "chat"
    # (the default), or add sub_agents
```

## The A2A Agent Card — your agent as a discoverable peer

MCP makes your agent a tool a *model* calls. **A2A** (Agent2Agent) makes it a
peer another *deployment* calls. A federation-configured gateway publishes a
real A2A **Agent Card** at a standard path:

```
GET  <deployment>/.well-known/agent-card.json   → the A2A Agent Card (metadata)
GET  <deployment>/.well-known/crewhaus.json      → CrewHaus discovery alias (cert-pin fingerprint)
POST <deployment>/federation                     → inbound A2A handler
```

The card is pure, always-safe-to-serve metadata built by
`@crewhaus/federation-protocol` — protocol version, `name`, `description`,
`url`, capabilities, and a `skills` list (a default `chat` skill when you
declare none). The **cert-pinning fingerprint** a CrewHaus peer needs is
deliberately *omitted* from the standard card and lives in the namespaced
`/.well-known/crewhaus.json` alias, so a deployment is both A2A-discoverable and
CrewHaus-cert-pinnable.

The `managed` daemon always emits this peer surface, but it's **env-gated at
runtime** — no recompile turns a deployment into a peer:

```bash
# Any unset ⇒ the federation routes answer 404 (not a peer).
export CREWHAUS_FEDERATION_DEPLOYMENT_ID=support-prod
export CREWHAUS_FEDERATION_ENDPOINT=https://support.example.com
export CREWHAUS_FEDERATION_FINGERPRINT=<64-hex sha256 of the leaf cert>

# Inbound gate: an empty/unset allowlist DENIES every inbound call.
# An explicit allowlist is REQUIRED to accept a remote peer.
export CREWHAUS_FEDERATION_ALLOWED_PEERS=research-prod,reviewer-prod
```

The inbound `POST /federation` handler decodes the envelope, runs the
deployment's app-level `authorize` (the allowlist check — authentication tells
you *who*, authorization decides *whether*), classifies the payload at
Pillar-3 origin `"federation"`, dispatches it onto a local run, and replies in
A2A shape. mTLS termination is the operator's transport floor — authentication ≠
authorization ≠ classification, all three apply.

## `sub_agents.<name>.federation.url` — delegate across the boundary

The consuming side. A local sub-agent normally spawns *inside* your deployment
(recipe 28). Add a `federation.url` and that entry becomes a **reference to a
remote peer** instead — the parent's `Task` call routes through
`@crewhaus/federation-router` to the peer's inbound A2A handler (whose Agent
Card lives at `<url>/.well-known/agent-card.json`):

```yaml
name: orchestrator
target: cli
agent:
  model: claude-sonnet-5
  instructions: You coordinate research and code review across teams.
  sub_agents:
    researcher:
      description: Deep-research specialist run by the research team.
      instructions: Delegate open-ended research questions here.
      federation:
        url: https://research.example.com   # remote peer, not a local spawn
    reviewer:
      description: Local code-reviewer that shares this deployment.
      instructions: Review diffs for correctness and security.
```

`description`/`instructions` still describe the peer to the parent's `Task`
tool — the local model needs to know *when* to delegate — but the **remote peer
owns its own prompt and model**. `federation` is a strict object today: `url`
and nothing else. Mix federated and local sub-agents freely in the same block,
as above.

## The three seams at a glance

| Seam                                   | Makes your agent…            | Consumer               | Where it's declared                          |
| -------------------------------------- | ---------------------------- | ---------------------- | -------------------------------------------- |
| `serve --mcp` / `expose.mcp`           | a **tool** (one turn/call)   | Claude Code, an IDE, another runtime | `expose:` block or `serve` flags   |
| A2A Agent Card (`/.well-known/…`)      | a discoverable **peer**      | another deployment     | `CREWHAUS_FEDERATION_*` env (managed daemon) |
| `sub_agents.<name>.federation.url`     | a **caller** of a peer       | your own `Task` tool   | the sub-agent's `federation` block           |

## Gotchas

- **`serve --mcp` is cli-only.** channel/managed daemons self-expose from their
  gateway `fetch` path; `serve` won't project them. Use `expose.mcp.transport:
  sse` on those shapes and let the daemon serve it.
- **`--sse` overrides `expose.mcp.transport`.** The explicit flag wins, so you
  can force SSE over a `stdio` spec — but not the reverse silently; be
  deliberate about which one you're relying on.
- **`per-subagent` without sub-agents fails to compile**, by design — it's a
  spec error, not a runtime surprise.
- **An empty `CREWHAUS_FEDERATION_ALLOWED_PEERS` denies everything.** Federation
  fails *closed* — an unset allowlist isn't "allow all", it's "allow none".
  Naming peers is mandatory to accept any inbound call.
- **The Agent Card omits the cert fingerprint on purpose.** Don't look for
  cert-pinning data in `agent-card.json` — it's in the `crewhaus.json` alias.

## What to read next

- **The wire underneath the card.** [Recipe 27 — Federation](27-federation.md):
  the envelope, mTLS pinning, traceparent propagation, error taxonomy.
- **The local sub-agent model `federation.url` extends.**
  [Recipe 28 — Sub-agents & Task](28-sub-agents-and-task.md).

## Pointers to source

- **`serve --mcp` resolution:** [`apps/cli/src/serve-mcp.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/serve-mcp.ts).
- **The MCP-server projection:** [`packages/mcp-server`](https://github.com/crewhaus/factory/blob/main/packages/mcp-server) (the `chat` tool + per-subagent tools).
- **The `expose:` block + `sub_agents.federation`:** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts).
- **The A2A Agent Card:** [`packages/federation-protocol/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/federation-protocol/src/index.ts) (`buildAgentCard`).
- **The gateway routes:** [`packages/gateway-server/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/gateway-server/src/index.ts) (`/.well-known/agent-card.json`, `/federation`).
