# crewhaus-demos

User-facing demos for [CrewHaus](https://github.com/crewhaus/factory): 22 `hello-*` example specs covering every target shape, 51 task-oriented [recipes](./recipes/INDEX.md), section-* example smokes under [examples/](./examples/), and the Studio + IDE tooling that lives around the compiler under [packages/](./packages/). Start with [GETTING-STARTED.md](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md).

## Showcase demos

Three demos go beyond minimal vertical slices and show what CrewHaus looks like at full power:

- **[hello-code](./hello-code/)** — a Claude-Code-shaped coding companion (`target: cli`): sub-agents for parallel codebase exploration, allow-listed bash, slash commands (`/init`, `/review`, `/test`, `/plan`), skills for debug / code-review / refactor, and project-memory bootstrap. ~190 lines of YAML.
- **[hello-chat](./hello-chat/)** — a ChatGPT-shaped conversational assistant (`target: cli`): web browsing, vision (image reading), a sandboxed Python/JS/shell code interpreter, parallel web-research sub-agent, and slash commands (`/browse`, `/code`, `/analyze`, `/summarize`). ~110 lines of YAML.
- **[hello-openclaw](./hello-openclaw/)** — an [OpenClaw](https://docs.openclaw.ai)-shaped always-on personal assistant (`target: channel`): one daemon listening on Slack + Telegram + Discord simultaneously, per-thread session isolation, planner sub-agent for multi-step tasks, skills for tone / approvals / (future) heartbeat. ~130 lines of YAML. 🦞

All three default to Claude but the `model:` field accepts any provider (GPT-4o, Gemini, Bedrock, local OpenAI-compatible servers) — each demo's README documents the swap.

## How it relates to factory

`crewhaus-demos` is its own repo, but the examples only make sense alongside a [crewhaus/factory](https://github.com/crewhaus/factory) checkout — they're compiled by factory's CLI and the compiled `dist/` outputs import `@crewhaus/*` runtime packages from factory. Until those packages ship to npm we resolve them via `tsconfig.json` `paths` pointing at a sibling `../factory/` checkout (override with `FACTORY_PATH` env in the test/smoke scripts).

```
parent-dir/
  factory/         ← github.com/crewhaus/factory checkout (provides the CLI + @crewhaus/* packages)
  demos/           ← this repo
```

Factory has zero references back to this repo — the dependency is one-way (demos → factory). When factory's `@crewhaus/*` packages publish to npm, the swap is a single-file change: delete the `paths` block in [`tsconfig.json`](./tsconfig.json) and add the `@crewhaus/*` packages each example's compiled `dist/` uses to `package.json` `dependencies`. See the `SWAP-WHEN-PUBLISHED` comment in `tsconfig.json` for the exact diff.

## Run

```bash
# from the demos/ directory
bun install

# compile and run any hello-* example
bun run compile:hello              # → hello-cli/dist/agent.ts
bun run run:hello                  # runs the compiled agent

# validate every recipe
bun run recipes:test
```

## Layout

```
demos/
  hello-cli/                   first agent — pick any of the 19 hello-* dirs
  hello-workflow/
  hello-channel/
  …
  recipes/
    01-cli-coding-agent.md
    …
    48-harness-designer.md
    INDEX.md                   decision tree for picking a recipe
  examples/                    section-* example specs (extracted from factory)
    section-15-smoke/          one workspace package per section reference spec
    …
  packages/                    Studio + IDE tooling (extracted from factory)
    studio-server/             Bun.serve daemon — spec CRUD, run inspection, plugin discovery
    studio-ui/                 Vanilla-TS UI for studio-server
    wizard/                    5-question guided spec creation
    scaffold-templates/        built-in spec templates per target shape
    trace-viewer/              Gantt-shaped trace timeline
    graph-visualizer/          force-directed layout for graph IRs
    plugin-sdk/                typed surface for third-party Studio plugins
    vscode-extension/          spec authoring + run-from-editor for VS Code
    jetbrains-plugin/          IntelliJ / WebStorm / PyCharm parity for the VS Code extension
    crewhaus-playground/       browser REPL for the compiler — Monaco editor + live trace
  scripts/
    test-recipes.ts            validates every recipe spec compiles
    smoke-recipes.ts
    section-{12,19,…25}-smoke.ts  end-to-end smoke tests for hello-* targets
  .github/workflows/
  package.json
  tsconfig.json
  tsconfig.base.json
  README.md
```

Each `hello-*` directory has a `crewhaus.yaml` (the spec), `README.md`, and optionally `.env.example`. Compiled output lands in `<example>/dist/` (gitignored).

The `packages/` directory is a bun workspaces tree; each package keeps its own `package.json` and `tsconfig.json`. They import `@crewhaus/*` runtime packages from the sibling `../factory/` checkout via the `paths` block in `tsconfig.base.json`.

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `FACTORY_PATH` | no | `../factory` | Absolute or relative path to a crewhaus/factory checkout |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | yes for `run:*` | — | Required to actually run compiled agents |
