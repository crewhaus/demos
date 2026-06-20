# Recipe 35 — Studio Walkthrough

End-to-end use of Studio — the local web UI for browsing specs,
running the spec wizard, building eval graders and datasets, and
discovering plugins, all backed by the studio-server HTTP API (which
also drives run inspection, graph layout, and cost summaries).

You'd use Studio when:

- You prefer **GUI-driven** spec authoring to handwriting YAML.
- You want **visual trace timelines** instead of `jq` over JSONL.
- You're doing **interactive HITL** (graph approvals through a web UI).
- You're **demoing** to teammates and the CLI is the wrong surface.

For day-to-day development, the CLI + editor plugins are usually
faster. Studio shines for onboarding, demos, and operations.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for what
  a spec is.

## Try it

Studio's five surfaces (server, trace-viewer, graph-visualizer,
plugin-sdk sandbox, multi-spec dashboard) are exercised end-to-end by
[`smoke/section-31-smoke/smoke.ts`](../smoke/section-31-smoke/smoke.ts) —
run `bun smoke/section-31-smoke/smoke.ts`. The IDE-side surfaces
ship as separate smokes:
[`smoke/section-35-vscode-smoke/`](../smoke/section-35-vscode-smoke),
[`smoke/section-35-jetbrains-smoke/`](../smoke/section-35-jetbrains-smoke),
and
[`smoke/section-35-playground-smoke/`](../smoke/section-35-playground-smoke).

## Starting Studio

Studio lives in the sibling [`crewhaus/utilities`](https://github.com/crewhaus/utilities)
checkout (`bun install` it once if you haven't):

```bash
cd ../utilities       # from demos/; adjust if your layout differs
bun run studio
```

Default UI port is 4243 (backend on 4242). Override either:

```bash
PORT=8080 bun run studio          # UI port (default 4243)
STUDIO_PORT=9090 bun run studio   # backend port (default 4242)
```

Workspace defaults to `<cwd>/specs` — every spec
authored in Studio lives here. Override:

```bash
STUDIO_WORKSPACE=/path/to/my/specs bun run studio
```

Open `http://localhost:4243/` in a browser. The landing page shows
the Specs tab.

## The Specs tab

Lists every spec in the workspace (`GET /api/specs`). Each row shows
the spec name and its target shape (cli / channel / managed / ...).

Click a name to open it (`GET /api/specs/:name`) — the spec's YAML
loads into a textarea with a **Save** button that writes back via
`PUT /api/specs/:name`. The IDE plugins
([Recipe 25](25-vscode-and-jetbrains.md)) carry the richer
syntax-highlighted, schema-validated editor; the Studio surface is the
plain textarea.

## The Wizard

The Wizard creates a spec in 5 questions:

1. **Target shape.** cli / channel / managed / graph / pipeline / ...
2. **Name.** Kebab-case slug; used verbatim as the spec's `name:` and
   stored as `<name>.yaml` in the workspace.
3. **Model.** A suggested-models hint, or type-your-own.
4. **Tools.** Comma-separated (only meaningful for cli / research /
   batch; other shapes skip it).
5. **Permission mode.** default / plan / auto.

(The v0 UI asks these through plain `window.prompt`s; a richer
form UI is a follow-up.)

The UI walks `/api/wizard/start` → `/api/wizard/step` (once per
answer) → `/api/wizard/compile`. The `compile` call **returns** the
generated artifacts as strings — `{ yaml, envExample, target, name }` —
it does not write anything itself:

1. The matching template from
   [`packages/scaffold-templates`](https://github.com/crewhaus/utilities/blob/main/scaffold-templates)
   is patched with the user's answers into the returned `yaml`.
2. `envExample` lists every `$VAR_NAME` the spec references.

The UI renders the generated YAML and shows a **Create spec** button.
Clicking it is what persists the spec — the UI `POST`s
`{ name, yaml }` to `/api/specs`. Total time: ~30 seconds.

## Running specs over the API

Run inspection is a server capability rather than an SPA tab. The
flow:

1. `POST /api/runs` with `{ specName, prompt }`.
2. Receive `201 { runId }`.
3. SSE-stream `GET /api/runs/:runId/events` (terminated by `event:
   done`). The server emits canned stubs unless you wire a
   `runDispatcher`; events are shaped for
   [`trace-viewer`](https://github.com/crewhaus/utilities/blob/main/trace-viewer)
   to render.

For long-running daemons (channel / managed), the server also exposes:

- **Cancel.** `POST /api/runs/:runId/cancel` aborts the dispatcher's
  signal.
- **HITL.** For graph runs paused at HITL,
  `POST /api/runs/:runId/hitl?nodeId=&decision=` pushes the decision.

The cancel + HITL endpoints make the daemon controllable over the
HTTP API without touching the CLI.

## Cost summary

The server aggregates spend (via a `costSummarySource`):

```
GET /api/cost-summary?tenant=&from=&to=
```

Returns `{ totalUsdMicros, byProvider }` for the given tenant /
date-range window — total spend plus a per-provider breakdown.

For multi-tenant deployments ([Recipe 11](11-managed-multitenant.md)),
the cost summary is the natural billing dashboard. For single-tenant
CLIs, it's the "how much did I spend today" view.

## Graph layouts

For `target: graph` specs, the studio-server renders the graph as SVG:

```
GET /api/graph-layout/:specName
```

The layout is **deterministic** (same spec → same SVG): the server
lowers the spec to IR and calls `layoutGraph`/`renderSvg` from the
separate [`graph-visualizer`](https://github.com/crewhaus/utilities/blob/main/graph-visualizer)
package. Nodes are placed by topological order; edges route around
nodes. (The studio-ui SPA has no graph tab — its five tabs are Specs,
Wizard, Graders, Datasets, and Plugins; the endpoint is consumed by the
graph-visualizer dev tooling, not a Studio SPA tab.)

`graph-visualizer` also exports the **live** layer: as a graph runs, a
consumer feeds SSE events through `applyEvent(state, event)` and
`renderLiveSvg` to re-color nodes by state —

- Active node (`running`): highlighted blue.
- Completed node (`done`): green check.
- HITL paused node (`paused-hitl`): yellow, with a "Decide" affordance.
- Failed node (`errored`): red.

Each node's current state JSON is tracked in `LiveGraphState` so the
renderer can surface it on demand.

## Trace replay

Trace replay is a server capability, not an SPA tab: `GET
/api/runs/:runId/replay` re-emits a past run's events from the
configured `replaySource` over the same SSE stream a live run uses
(see [Recipe 31](31-session-resume-and-replay.md)). The events are
shaped for the separate
[`trace-viewer`](https://github.com/crewhaus/utilities/blob/main/trace-viewer)
package to render, which the IDE plugins' webview also uses
([Recipe 25](25-vscode-and-jetbrains.md)).

## Plugins

Studio is extensible via plugins from `~/.crewhaus/plugins/`. A plugin
is a **single `index.ts`** that default-exports `definePlugin({...})`
from [`@crewhaus/studio-plugin-sdk`](https://github.com/crewhaus/utilities/blob/main/studio-plugin-sdk) —
no `package.json`, `plugin.json`, or separate UI file:

```
~/.crewhaus/plugins/
  my-plugin/
    index.ts
```

```typescript
import { definePlugin } from "@crewhaus/studio-plugin-sdk";

export default definePlugin({
  name: "my-plugin",
  version: "0.1.0",
  description: "Adds a custom side-pane to the studio.",

  hooks: {
    onSpecLoad(spec) {},        // spec: { name, target, raw }
    onTraceEvent(event) {},     // fires for every SSE event
    onEvalSampleRendered(s) {}, // s: { id, passed, ... }
  },

  panes: [
    { id: "my-pane", title: "My Pane", html: "<div>Hello</div>" },
  ],

  permissions: {
    fs: ["read:~/.crewhaus/plugins/my-plugin/data/**"],
    net: ["fetch:https://api.example.com/**"],
  },
});
```

`definePlugin` validates the definition (`name`/`version` required,
pane `id`s unique, permission entries prefixed `read:`/`fetch:`) and
freezes it. studio-server discovers the file when its `/api/plugins`
endpoint scans `pluginRoot`; the Plugins tab renders each plugin's
`panes[]`.

### Sandboxing

Today's plugin sandbox is **permission-allowlist only**: a plugin's
`permissions.fs` / `permissions.net` globs gate each I/O attempt
(`isFsAllowed` / `isNetAllowed`), absent permissions fail closed, and
`assertPluginPathsStaySandboxed` rejects pane HTML whose `file://`
URLs escape the sandbox root at load. Full script isolation
(worker / QuickJS) lands in a follow-up.

For untrusted plugins, the contract is "review the code before
installing" — this is a single-user system today, not a
plugins-from-strangers marketplace.

## Multi-spec dashboard

studio-ui isn't a Studio *tab* — the SPA's five tabs are Specs,
Wizard, Graders, Datasets, and Plugins — but it does export
`renderMultiSpecDashboard(rows)`, an HTML-table helper you can embed in
your own page to show per-spec metrics (runs, cost, pass-rate, p50,
p95).

Useful as a "single pane of glass" for a small fleet of specs.
For larger fleets (10+ specs), grafana / OTel exporters
([Recipe 17](17-observability.md)) scale better.

## Operating tips

- **Workspace isolation.** Studio writes only under
  `<cwd>/specs` (override with `STUDIO_WORKSPACE`). So you can run
  Studio against a project without polluting the rest of the repo.
- **HTTPS.** Studio listens on HTTP by default. For remote use,
  reverse-proxy behind nginx/caddy for TLS.
- **Auth.** Studio has **no authentication** by default — assume
  the host is trusted. For shared deployments, put a basic-auth proxy
  in front or use the managed gateway ([Recipe 11](11-managed-multitenant.md)).

## Running the smokes

```bash
bun run smoke:section-35-playground
```

Validates the studio-server + studio-ui + wizard end-to-end against
a fixture workspace. Doesn't open a browser; checks the API surface
plus the SSR-rendered HTML for key UI strings.

## Things that look like Studio but aren't

| Symptom                                                          | Better tool                                       |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| You're authoring specs by typing YAML.                           | CLI + IDE plugin ([Recipe 25](25-vscode-and-jetbrains.md)). |
| You're tailing logs in production.                                | OTel + grafana ([Recipe 17](17-observability.md)). |
| You're shipping a customer-facing UI.                             | Build your own — Studio is internal tooling.       |
| You want CLI-equivalent automation.                               | `crewhaus` CLI directly.                            |

## What to read next

- **VS Code / JetBrains parity.** [Recipe 25 — VS Code and JetBrains](25-vscode-and-jetbrains.md).
- **The template marketplace.** [Recipe 26 — Template Marketplace](26-template-marketplace.md).
- **Session resume / replay.** [Recipe 31 — Session Resume and Replay](31-session-resume-and-replay.md).

## Pointers to source

- **Server:** [`packages/studio-server`](https://github.com/crewhaus/utilities/blob/main/studio-server).
- **UI:** [`packages/studio-ui`](https://github.com/crewhaus/utilities/blob/main/studio-ui).
- **Wizard:** [`packages/wizard`](https://github.com/crewhaus/utilities/blob/main/wizard).
- **Scaffolds:** [`packages/scaffold-templates`](https://github.com/crewhaus/utilities/blob/main/scaffold-templates).
- **Trace viewer:** [`packages/trace-viewer`](https://github.com/crewhaus/utilities/blob/main/trace-viewer).
- **Graph visualizer:** [`packages/graph-visualizer`](https://github.com/crewhaus/utilities/blob/main/graph-visualizer).
- **Plugin SDK:** [`studio-plugin-sdk`](https://github.com/crewhaus/utilities/blob/main/studio-plugin-sdk).
- **Launcher:** [`scripts/studio-launcher.ts`](https://github.com/crewhaus/factory/blob/main/scripts/studio-launcher.ts).
- **Module catalog reference:** §26, §31 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
