# crewhaus-demos

User-facing demos for [CrewHaus](https://github.com/crewhaus/factory): 22 `hello-*` example specs covering every target shape, 55 task-oriented [recipes](./recipes/INDEX.md), and section-* example smokes under [examples/](./examples/). The Studio + IDE tooling that lives around the compiler is now in the sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) repo. Start with [GETTING-STARTED.md](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md).

## Showcase demos

Three demos go beyond minimal vertical slices and show what CrewHaus looks like at full power. Each one is a wink at a tier-one mainstream harness — feel familiar, fork and make it your own:

- **[hello-procode](./hello-procode/)** — a pro-grade terminal coding companion (`target: cli`) à la Claude Code / Cursor: sub-agents for parallel codebase exploration, allow-listed bash, slash commands (`/init`, `/review`, `/test`, `/plan`), skills for debug / code-review / refactor, project-memory auto-load. ~190 lines of YAML.
- **[hello-prochat](./hello-prochat/)** — a pro-grade conversational assistant (`target: cli`) à la ChatGPT / Claude.ai: web browsing, vision (image reading), sandboxed Python/JS/shell code interpreter, image generation, document ingest, parallel web-research sub-agent, slash commands (`/browse`, `/code`, `/analyze`, `/summarize`, `/imagine`, `/ingest`). ~110 lines of YAML.
- **[hello-multichat](./hello-multichat/)** — an always-on multi-channel personal assistant (`target: channel`) à la OpenClaw: one daemon listening on Slack + Telegram + Discord simultaneously, per-thread session isolation, planner sub-agent for multi-step tasks, scheduled heartbeats, emoji status reactions, control-UI gateway. ~140 lines of YAML. 🦞

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

# see every available demo
bun run list

# compile and run any hello-* example
bun run compile hello-cli          # → hello-cli/dist/agent.ts
bun run run hello-cli              # runs the compiled agent

# validate every recipe
bun run recipes:test
```

Adding a new demo: drop a directory with a `crewhaus.yaml`, then
`bun run compile <name>` and `bun run run <name>` work immediately —
no package.json edit required.

## Layout

```
demos/
  hello-cli/                   first agent — pick any of the 22 hello-* dirs
  hello-workflow/
  hello-channel/
  …
  recipes/
    01-cli-coding-agent.md
    …
    55-meta-cross-references.md
    INDEX.md                   decision tree for picking a recipe
  examples/                    section-* example specs (extracted from factory)
    section-07-cli-smoke/      one workspace package per section reference spec
    section-09-mcp-smoke/
    section-15-smoke/
    …
  scripts/
    test-recipes.ts            validates every recipe spec compiles
    smoke-recipes.ts
    section-{12,19,…25}-smoke.ts  end-to-end smoke tests for hello-* targets
  .github/workflows/
  package.json
  tsconfig.json
  README.md
```

Each `hello-*` directory has a `crewhaus.yaml` (the spec), `README.md`, and optionally `.env.example`. Compiled output lands in `<example>/dist/` (gitignored).

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `FACTORY_PATH` | no | `../factory` | Absolute or relative path to a crewhaus/factory checkout |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | yes for `run:*` | — | Required to actually run compiled agents |
