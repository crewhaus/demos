# Recipe 69 — Deploying the real loop to Cloudflare Workers

**Loop contract 0.4 — Batch F (the deploy half of the loop).**
**Packages:** `@crewhaus/worker-runtime` (the platform-neutral loop core),
`@crewhaus/target-cf-worker-{cli,workflow,graph}` (the edge emitters),
`@crewhaus/cloud-adapter-{flyio,render,railway,heroku}` (the PaaS adapters).
**CLI:** `crewhaus dev`, `crewhaus compile --emit-as cf-worker`,
`crewhaus deploy <fly|render|railway|heroku>`.
**Shipped in:** crewhaus 0.4.0 ([CHANGELOG](https://github.com/crewhaus/factory/blob/main/CHANGELOG.md)).

## What this recipe shows

Before 0.4, a `cf-worker` target was a thin request handler: it could stream a
model reply, but the compiler flatly rejected `tools:` — "cf-worker does not
support tools." That's gone. In 0.4 the agent loop itself was extracted into a
platform-neutral core, `@crewhaus/worker-runtime`, that imports no `node:*`
builtin and calls neither `Date.now()` nor `Math.random()` — so the *same* loop
(turn FSM, model-stream orchestration, tool dispatch + validation + permission
gating, budget/limit enforcement, loop detection, trace emission) runs on a
Cloudflare Worker.

This recipe walks the edge-deploy path end to end:

```
crewhaus dev                     →  the local edit → observe loop (recompile + relaunch on save)
crewhaus compile --emit-as cf-worker  →  a Worker bundle (worker.js + wrangler.toml + README)
wrangler deploy                  →  the real loop, live on the edge
```

and closes with the *other* Batch F deploy verb — `crewhaus deploy <paas>` —
for the long-running daemon shapes that can't collapse to a stateless Worker.

## You'd reach for this when

- You want an agent at the **edge** — low-latency, globally distributed, no
  container to keep warm — and your tools are all network/API calls.
- You're iterating on a spec and want the **fastest inner loop**: save the
  file, watch it recompile and relaunch, read the per-turn trace.
- You're shipping a **daemon** shape (a Slack bot, a managed multitenant
  service, a batch worker) to a PaaS and want scaffolded deploy manifests
  rather than hand-written ones.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) — a runnable `cli`
  spec is the simplest thing to push to the edge.
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) installed and
  a Cloudflare account, for the actual `wrangler deploy`.
- [Recipe 36 — Cloud Deploy](36-cloud-deploy.md) and
  [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md) for the
  managed/Kubernetes and spec-versioning deploy paths this recipe sits beside.

## Step 1 — the develop loop with `crewhaus dev`

`crewhaus dev` is the tight local loop: it compiles the spec **in memory**, runs
the emitted bundle as a *supervised child*, and on every change to the spec or
the authoring dir (commands, skills) it recompiles and relaunches the child.
`CREWHAUS_TRACE=pretty` is on by default, so each turn streams, and a per-turn
`[dev]` summary line prints as the child completes turns:

```bash
cd starters/cli
crewhaus dev crewhaus.yaml                 # edit crewhaus.yaml in another pane; it relaunches on save
crewhaus dev crewhaus.yaml --debounce 400  # coalesce rapid saves (ms)
crewhaus dev crewhaus.yaml --once          # compile + boot ONCE and exit — a credential-free CI smoke check
```

`--once` is the CI boot check: it proves the spec compiles and the bundle boots
without needing real provider credentials. For the long-running shapes (channel,
managed, crew, voice, batch) `dev` also restarts the child if it *crashes*; a
one-shot `cli` run exiting is normal completion, so it isn't restarted.

`dev` runs the Node loop locally — it's your edit/observe surface. The edge
bundle you ship in Step 2 runs the *same* loop core through the Worker
platform.

## Step 2 — emit the edge bundle

`crewhaus compile --emit-as cf-worker` runs the same lower → emit path the
studio's compiler-worker serves for `POST /compile { emitAs: "cf-worker" }`, so
the local bundle is byte-identical to the hosted one:

```bash
crewhaus compile crewhaus.yaml --emit-as cf-worker -o dist/edge
```

The bundle is a ready-to-deploy Worker:

| File           | What it is                                                        |
| -------------- | ----------------------------------------------------------------- |
| `worker.js`    | the entry — `runWorkerLoop` with the edge-safe tool wiring        |
| `wrangler.toml`| the deploy descriptor (sanitized spec name, `nodejs_compat`)      |
| `package.json` | `scripts.deploy = wrangler deploy`, `scripts.dev = wrangler dev --local` |
| `README.md`    | the generated deploy guide (the `wrangler` flow below)            |

`--emit-as cf-worker` supports the **single-shot / build-only** targets —
`cli`, `workflow`, and `graph`. The daemon and multi-stage shapes (channel,
managed, crew, …) have no cf-worker emitter; use `crewhaus deploy <paas>`
(Step 4) for those.

Deploy is the ordinary wrangler flow:

```sh
cd dist/edge
npm install                              # resolve the crewhaus runtime + edge tools
wrangler secret put ANTHROPIC_API_KEY    # one-time Worker secret
wrangler deploy                          # bundles worker.js + its imports
```

The deployed Worker exposes a `/chat` endpoint that streams the *same* SSE trace
vocabulary the Node loop emits — `turn_start`, `model_request`,
`model_response`, `cost_accrual`, `tool_call_start`, `tool_call_end`,
`turn_end` — so your existing trace consumers work unchanged against the edge.

## Step 3 — the edge-safety gate

A Worker is a stateless request handler with `fetch` and (optionally) a KV
binding, and nothing else — no process to spawn, no local filesystem, no
sandbox, no attached device. So the old blanket rejection is replaced by a
**precise, per-tool** gate (`@crewhaus/worker-runtime/tool-policy`, the single
source of truth the compiler imports). Every tool in your `tools:` list is
classified at compile time into one of three verdicts:

**Edge-safe builtins — compiled and wired.** Their side effect is an outbound
`fetch` or a KV read/write:

| Tool            | Edge side effect            |
| --------------- | --------------------------- |
| `fetch`         | pure `fetch`                |
| `webFetch`      | pure `fetch`                |
| `webSearch`     | pure `fetch`                |
| `sendMessage`   | outbound API via `fetch`    |
| `imageGenerate` | outbound API via `fetch`    |
| `todoWrite`     | working memory via KV       |

Plus any `mcp__<server>__<tool>` — remote MCP over SSE/HTTP is just an outbound
request, so it's edge-native. (Durable memory's `Remember`/`Recall` are also
edge-safe via KV, but they're wired from the `memory:` block, not `tools:`, so
they never reach this gate.)

**Host tools — the compile hard-fails**, with a category-specific reason:

```
cf-worker target cannot run 2 host tool(s): tool "bash" runs a host shell
process — not available on a Cloudflare Worker; tool "read" reads the local
filesystem — not available on a Cloudflare Worker. …use the cli target for
them, or remove them.
```

Rejected categories: shell/process (`bash`/`shell`/`bashOutput`/`killShell`),
code execution (`python`/`javascript`), filesystem
(`read`/`write`/`edit`/`glob`/`grep`/`readImage`/`ingestDocument`), the on-disk
code index (`codegraph*`), and computer-use/browser perception
(`navigate`/`screenshot`/`mouseKeyboard`/…).

**Unrecognised custom tools — permitted, but warned.** The compiler can't verify
a user-registered tool only touches `fetch`/KV, so it emits an *edge-unsafe-tool*
warning and wires it anyway rather than silently shipping a host-reaching tool.
Read the warning and confirm the tool does no process/filesystem/device I/O.

## v1 scope — the edge caveats

The edge loop's v1 scope is deliberately **tools + budget + limits + trace**.
Two things stay Node-only, so know them before you push:

- **No compaction or recovery on the edge.** Those services are Node-coupled
  (event-log, session-store, compaction, recovery, audit sinks) and don't run on
  a stateless Worker. A context overflow therefore doesn't compact — it ends the
  run with a classified `context_overflow` frame. Keep edge conversations
  short, or set a `limits.context_limit` you won't blow.
- **Anthropic models only.** The edge adapter speaks the Anthropic Messages API,
  so a `cf-worker` target rejects any model that routes to another provider
  (`openai/…`, `gemini/…`, `bedrock/…`, `local/…`) at compile:

  ```
  agent.model "gpt-5" routes to provider "openai" — cf-worker targets
  currently support claude-* models only — use the cli target for other providers
  ```

Everything else — `budget:`, the `limits:` ceilings ([Recipe 58 — Safe
Production Ops](58-safe-production-ops.md)), loop detection, the full trace
vocabulary — is enforced on the edge exactly as it is under Node.

## Step 4 — `crewhaus deploy <paas>` for the daemon shapes

A `cli`/`workflow`/`graph` bundle is a single-shot request handler that fits a
Worker. A **daemon** shape — a channel bot, a managed multitenant service, a
batch worker, a browser or voice loop — is a long-running server the platform
has to keep alive, which a stateless Worker can't be. For those, Batch F adds
`crewhaus deploy <provider> <spec>`, which scaffolds the PaaS deploy manifests:

```bash
crewhaus deploy fly starters/channel/crewhaus.yaml -o deploy/fly
```

- **Providers:** `fly`, `render`, `railway`, `heroku`.
- **Shape gate:** only the daemon shapes (`channel`, `managed`, `batch`,
  `voice`, `browser`) are deployable this way. A single-shot shape (`cli`,
  `workflow`, `graph`, …) is rejected up front — those go to the edge via Step 2.
- **Scaffold by default; `--live` deploys.** Without `--live` the command writes
  the manifests and stops. `--live` is gated on the provider's credential env
  var (`FLY_API_TOKEN`, `RENDER_API_KEY`, `RAILWAY_API_TOKEN`, `HEROKU_API_KEY`)
  — absent, the command names the missing variable and scaffolds only, so the
  CLI gate and the adapter's own gate agree.

```bash
# once the token is set, drive the real API deploy
FLY_API_TOKEN=… crewhaus deploy fly starters/channel/crewhaus.yaml --live --app my-bot --region iad
```

`--app` names the app (else it's derived from the spec name), and `--image`
overrides the per-shape CrewHaus image the manifest references.

## Two deploy paths, one decision

| Your shape                        | Path                              | Runtime                          |
| --------------------------------- | --------------------------------- | -------------------------------- |
| `cli` / `workflow` / `graph`      | `compile --emit-as cf-worker` → `wrangler deploy` | stateless Worker, `runWorkerLoop` |
| `channel` / `managed` / `batch` / `voice` / `browser` | `deploy <fly\|render\|railway\|heroku>` | long-running daemon on a PaaS |

## Gotchas recap

| Gotcha | Rule |
| ------ | ---- |
| Host tools on the edge | `bash`/`read`/`python`/filesystem/`codegraph*`/browser-perception hard-fail the cf-worker compile — use the `cli` target |
| Custom tool on the edge | permitted but *edge-unsafe-tool* warned; the compiler can't prove it's fetch/KV-only — verify it yourself |
| Non-Anthropic model | cf-worker speaks only the Anthropic API; `openai/`/`gemini/`/`bedrock/`/`local/` models are rejected at compile |
| Context overflow at the edge | no compaction on a Worker — a run ends with a classified `context_overflow` frame; cap it with `limits.context_limit` |
| `--emit-as cf-worker` shape | only `cli`/`workflow`/`graph`; daemon shapes have no edge emitter — use `deploy <paas>` |
| `deploy <paas>` shape | only daemon shapes (`channel`/`managed`/`batch`/`voice`/`browser`); single-shot shapes go to the edge |
| `deploy --live` without a token | scaffolds only and names the missing `*_API_TOKEN`/`*_API_KEY` — it never deploys blind |
| `crewhaus dev --once` | boots the bundle once and exits — the credential-free CI smoke check, not a run |

## Where to go next

- [Recipe 58 — Safe Production Ops](58-safe-production-ops.md) — the `limits:`
  ceilings and `budget:` cap the edge loop enforces.
- [Recipe 36 — Cloud Deploy](36-cloud-deploy.md) — the managed/Terraform/Helm
  path for a full cloud deployment.
- [Recipe 21 — Deployment and Canary](21-deployment-and-canary.md) — versioning
  the spec you deploy and cutting over with an eval-gated canary.

## Pointers to source

- **The platform-neutral loop core:** [`packages/worker-runtime`](https://github.com/crewhaus/factory/blob/main/packages/worker-runtime).
- **The edge-safety tool policy:** [`packages/worker-runtime/src/tool-policy.ts`](https://github.com/crewhaus/factory/blob/main/packages/worker-runtime/src/tool-policy.ts).
- **`compile --emit-as cf-worker`:** [`apps/cli/src/cf-worker-emit.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/cf-worker-emit.ts).
- **The cf-worker CLI emitter (bundle files + wiring):** [`packages/target-cf-worker-cli/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/target-cf-worker-cli/src/index.ts).
- **`crewhaus dev`:** [`apps/cli/src/dev.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/dev.ts).
- **`crewhaus deploy <paas>`:** [`apps/cli/src/cloud-deploy.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/cloud-deploy.ts).
