# crewhaus-demos

User-facing demos for [CrewHaus](https://github.com/crewhaus/factory): copy-pasteable [starters](./starters/) covering every target shape, 56 task-oriented [walkthroughs](./walkthroughs/INDEX.md), and section-* example smokes under [smoke/](./smoke/). The Studio + IDE tooling that lives around the compiler is now in the sibling [crewhaus/utilities](https://github.com/crewhaus/utilities) repo. Start with [GETTING-STARTED.md](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md).

## Showcase demos

Three demos go beyond minimal vertical slices and show what CrewHaus looks like at full power. Each one is a wink at a tier-one mainstream harness — feel familiar, fork and make it your own:

- **[procode](./starters/showcases/procode/)** — a pro-grade terminal coding companion (`target: cli`) à la Claude Code / Cursor: sub-agents for parallel codebase exploration, allow-listed bash, slash commands (`/init`, `/review`, `/test`, `/plan`), skills for debug / code-review / refactor, project-memory auto-load. ~190 lines of YAML.
- **[prochat](./starters/showcases/prochat/)** — a pro-grade conversational assistant (`target: cli`) à la ChatGPT / Claude.ai: web browsing, vision (image reading), sandboxed Python/JS/shell code interpreter, image generation, document ingest, parallel web-research sub-agent, slash commands (`/browse`, `/code`, `/analyze`, `/summarize`, `/imagine`, `/ingest`). ~110 lines of YAML.
- **[multichat](./starters/showcases/multichat/)** — an always-on multi-channel personal assistant (`target: channel`) à la OpenClaw: one daemon listening on Slack + Telegram + Discord simultaneously, per-thread session isolation, planner sub-agent for multi-step tasks, scheduled heartbeats, emoji status reactions, control-UI gateway. ~140 lines of YAML. 🦞

All three default to Claude but the `model:` field accepts any provider (GPT-4o, Gemini, Bedrock, local OpenAI-compatible servers) — each demo's README documents the swap.

## How it relates to factory

`crewhaus-demos` is its own repo, but the examples only make sense alongside the `@crewhaus/*` packages — they're compiled by the `crewhaus` CLI and the compiled `dist/` outputs import `@crewhaus/runtime-core` and friends.

This repo deliberately keeps no `@crewhaus/*` runtime in its own `package.json` — `bun install` only pulls `@types/bun` and `typescript`. The compile scripts find the CLI via this precedence:

1. `FACTORY_PATH` env or a `../factory` sibling checkout → contributor / dual-checkout mode (changes in `factory/` flow into demo runs without republishing). **CI uses this path.**
2. `node_modules/crewhaus` — if you ran `bun add -d crewhaus` yourself in this repo.
3. `bun x crewhaus` — falls back to a globally installed binary.

**Default path for users following the docs:** install the `crewhaus` CLI (the bare, unscoped npm package — the old `@crewhaus/cli` name is deprecated and now just points at it), then `bun run compile <demo>` shells out to the installed binary. The CLI is available from five channels:

```bash
# npm / Bun (requires Bun >= 1.2)
npm install -g crewhaus            #  or:  bun add -d crewhaus

# Homebrew (macOS / Linux)
brew tap crewhaus/tap && brew install crewhaus

# Scoop (Windows)
scoop bucket add crewhaus https://github.com/crewhaus/scoop-bucket && scoop install crewhaus

# winget (Windows)
winget install CrewHaus.CLI

# apt (Debian / Ubuntu, signed)
curl -fsSL https://crewhaus.github.io/apt/key.gpg | sudo gpg --dearmor -o /usr/share/keyrings/crewhaus.gpg
echo "deb [signed-by=/usr/share/keyrings/crewhaus.gpg] https://crewhaus.github.io/apt stable main" | sudo tee /etc/apt/sources.list.d/crewhaus.list
sudo apt update && sudo apt install crewhaus
```

The Homebrew / Scoop / winget / apt binaries are self-contained — no Bun or Node runtime needed. Only the npm package needs Bun. After install, `crewhaus --version` prints e.g. `0.1.3`.

**Contributor / dual-checkout path:** clone [crewhaus/factory](https://github.com/crewhaus/factory) as a sibling — no extra install needed, the scripts and `tsconfig.json` `paths` block pick it up.

```
parent-dir/
  factory/         ← sibling checkout (CI also uses this)
  demos/           ← this repo
```

Factory has zero references back to this repo — the dependency is one-way (demos → factory).

## Run

```bash
# from the demos/ directory
bun install

# see every available starter
bun run list

# compile and run any starter (pass the path printed by `bun run list`)
bun run compile starters/cli                       # → starters/cli/dist/agent.ts
bun run run starters/cli                           # runs the compiled agent
bun run compile starters/channels/discord          # nested channel adapter
bun run compile starters/showcases/procode         # nested showcase

# showcase aliases for muscle memory
bun run compile:procode  # ↔ bun run compile starters/showcases/procode
bun run compile:prochat
bun run compile:multichat

# validate every recipe
bun run walkthroughs:test
```

Adding a new starter: drop a directory under `starters/` with a `crewhaus.yaml`, then `bun run compile starters/<path>` and `bun run run starters/<path>` work immediately — no package.json edit required.

## Layout

```
demos/
  starters/                    user-facing: every dir is a copy-pasteable spec
    cli/                       first agent — pick any of the target shapes
    workflow/
    channel/                   the generic channel adapter (Slack reference)
    crew/  graph/  rag/  research/  batch/  voice/  browser/
    managed/  eval/  federation/  harness-designer/  optimize/
    channels/                  platform-specific channel adapter variants
      discord/  imessage/  telegram/  whatsapp/
    showcases/                 "full power" tier-1 harness imitations
      procode/  prochat/  multichat/
  walkthroughs/                     56 task-oriented walkthrough docs
    01-cli-coding-agent.md
    …
    55-egress-fabric.md
    INDEX.md                   decision tree for picking a recipe
  smoke/                       contributor-facing per-section regression tests
    section-12-smoke/          single-file smokes (smoke.ts entry)
    section-07-cli-smoke/      spec-only smokes (crewhaus.yaml entry)
    section-09-mcp-smoke/
    section-27-smoke/          executable smokes (smoke.ts entry)
    section-33-{discord,imessage,telegram,whatsapp}-smoke/
    section-34-federation-smoke/
    section-35-{vscode,jetbrains,playground}-smoke/
    section-36-sandbox-image-{dotnet,go,java,php,r,ruby,rust,registry}-smoke/
    section-37-exporter-{datadog,honeycomb,newrelic,splunk}-smoke/
    section-38-grader-{multimodal,nlg-metrics,safety-classifiers,semantic-similarity}-smoke/
    section-39-{audit-encryption,compliance-controls,data-retention-engine,pii-redactor}-smoke/
    section-40-{example-corpus,template-marketplace-client,template-registry}-smoke/
    hello-{procode,prochat}-smoke/  showcase smokes
  scripts/
    compile.ts                 parameterized: bun run compile <starter>
    run.ts                     parameterized: bun run run <starter>
    list.ts                    enumerates starters with target + README status
    test-walkthroughs.ts       static walkthrough validator (links, scripts, specs)
    smoke-walkthroughs.ts      runtime walkthrough smoke (compile + optional run)
  .github/workflows/
  package.json
  tsconfig.json
  README.md
```

Each starter directory has a `crewhaus.yaml` (the spec), `README.md`, and optionally `.env.example`. Compiled output lands in `<starter>/dist/` (gitignored).

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `FACTORY_PATH` | no | `../factory` | Absolute or relative path to a crewhaus/factory checkout |
| `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` | yes for `run:*` | — | Required to actually run compiled agents. Put it in `demos/.env` (Bun auto-loads `./.env` on every `bun run`, so run all walkthrough commands from the repo root) or export it in your shell. |
