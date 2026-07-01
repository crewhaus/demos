# Walkthroughs

> Task-oriented walkthroughs for every major feature of factory.
> All 57 recipes are **complete** as of 2026-07-01. Every recipe is
> statically validated by `bun run walkthroughs:test` and every recipe with
> a `compile:*` script in its frontmatter is also compile-smoke
> validated by `bun run walkthroughs:smoke`.

If you're new here, start with [`GETTING-STARTED.md`](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md)
first. Each recipe assumes you've read it.

Every recipe is statically validated by `bun run walkthroughs:test`
([`scripts/test-walkthroughs.ts`](../scripts/test-walkthroughs.ts)). Recipes
that opt into a `test:` frontmatter block also get compile-smoke
coverage via `bun run walkthroughs:smoke`. See [Testing recipes](#testing-recipes)
below.

### Conventions

**Each starter is a standalone harness.** To run one on its own — the
way you'd ship it — install the `crewhaus` CLI (npm / Homebrew / Scoop /
winget / apt) and run from inside the starter directory:

```bash
cd starters/<name>
cp .env.example .env       # add ANTHROPIC_AUTH_TOKEN (if the starter ships one)
bunx crewhaus compile crewhaus.yaml -o dist
bunx crewhaus run crewhaus.yaml      # or: bun dist/agent.ts
```

The runtime resolves the spec, local data sources, MCP servers, and the
`.crewhaus/` session store from the directory you run in, so always run
from inside the harness directory.

**Convention used by the snippets below.** For brevity, the walkthrough
shell snippets are written to run from the **`demos/` repo root** using
the in-tree `bun run compile <name>` / `bun run run <name>` scripts —
they resolve the sibling `../factory` checkout and auto-load `demos/.env`
(Bun loads `./.env` on every `bun run`). All relative paths
(`starters/browser`, `smoke/section-25-smoke/...`) are repo-root-relative.
Every `bun run compile starters/<name>` has the standalone equivalent
`cd starters/<name> && bunx crewhaus compile crewhaus.yaml` (and likewise
for `run`).

---

## Pick a recipe — diagnostic decision tree

The 57 recipes cover a lot of ground. Most readers don't need to scan
the table of contents; they need to find the shape that matches the
problem they brought. Walk this tree from the top:

0. **Not sure what you want yet?** → [Recipe 48 — Harness
   Designer](48-harness-designer.md) interviews you about intent and
   writes the spec for you. Use this when you can describe the *goal*
   but not the *shape*. Everything below is for when you'd rather
   pick the shape yourself.
0.5. **Want to imitate a top-tier production harness end-to-end?** →
   pick the closest match and fork from there:
     - "Like Claude Code / Cursor" → [Recipe 49 — Pro-grade Coder](49-procode.md)
       (sub-agents, allow-listed bash, slash commands, project memory)
     - "Like ChatGPT / Claude.ai" → [Recipe 50 — Pro-grade Chat](50-prochat.md)
       (web browsing, vision, image generation, sandboxed code
       interpreter, document ingest)
     - "Like OpenClaw" → [Recipe 51 — Multi-channel Personal Assistant](51-multichat.md)
       (one daemon listening on Slack + Telegram + Discord with
       per-thread session isolation, heartbeat, emoji acks, control-UI
       gateway)
   Each forks the canonical shape from recipes 1, 3, etc., but with
   every primitive wired up — they're the "full power" examples.
1. **Are you just trying the system for the first time?** → start at
   [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md). Every other
   recipe assumes you've worked through it.
2. **Does the task need human-in-the-loop approval between steps, or
   the ability to resume after a crash?** → [Recipe 05 — Stateful
   Graph](05-stateful-graph.md). HITL pauses and durable checkpoints
   are graph-shaped, not workflow-shaped.
3. **Is the task highly parallelizable — multiple subtasks that each
   benefit from a dedicated specialist role?** → [Recipe 04 — Multi-Agent
   Crew](04-multi-agent-crew.md). (Google's scaling study found
   centralized multi-agent topologies help parallelizable reasoning,
   while *hurting* sequential reasoning measurably — see the
   top-of-page "When NOT to use this" callouts in recipes 02 and 04.)
4. **Is each step a clearly-bounded "extract → transform → format"
   stage with a single handoff?** → [Recipe 02 — Sequential
   Workflow](02-sequential-workflow.md). Determinism over flexibility.
5. **Is retrieval quality the main engineering problem (ranking,
   chunking, citation faithfulness)?** → [Recipe 06 — RAG
   Pipeline](06-rag-pipeline.md). Pipeline-first beats agent-first when
   the bottleneck is documents, not reasoning.
6. **Are you shipping to a chat channel (Slack, Discord, Telegram,
   WhatsApp, iMessage)?** → [Recipe 03 — Slack Bot](03-slack-bot.md)
   first, then the matching adapter in Part F.
7. **Do you have a labelled dataset and want to optimize program
   quality rather than hand-tune prompts?** → [Recipe 12 — Eval
   Harness](12-eval-harness.md) to set up the dataset, then
   [Recipe 42 — Active Optimization](42-active-optimization.md) for
   DSPy-style spec mutation (the empirical result that motivates the
   project: measurable accuracy gains from program-layer prompt
   optimization).
7.5. **No labelled dataset — but real users rating real answers?** →
   [Recipe 56 — Response Ratings](56-response-ratings.md). `crewhaus
   rate` / web-UI thumbs / Slack 👍👎 become the dataset and grader
   that Recipe 42's loop consumes (`optimize --ratings`).
8. **Are you running long-horizon autonomous work (research, batch
   jobs)?** → [Recipe 07 — Autonomous Research](07-autonomous-research.md)
   or [Recipe 08 — Batch Worker](08-batch-worker.md). Both lean on
   compaction, durable sessions, and background execution.
9. **Voice or browser surface?** → [Recipe 09 — Voice
   Agent](09-voice-agent.md) / [Recipe 10 — Browser
   Agent](10-browser-agent.md). Note the elevated trust surface for
   browser tools — read the security primer below first.
10. **Multi-tenant SaaS?** → [Recipe 11 — Managed
    Multitenant](11-managed-multitenant.md), then Part C for hardening.
11. **Touching wallets, contracts, or chain events?** → Part H,
    starting with [Recipe 43 — Wallet-gated
    action](43-wallet-gated-action.md).

The flowchart is a teaching scaffold, not a cage. Once you understand
each pure topology, hybrid systems compose naturally — graph nodes can
embed crews, crews can call workflows, channels can wrap any of them.

## Security primer — read this before you ship anything

The **Pillar 3** "security as fabric" foundation
([CLAUDE.md](https://github.com/crewhaus/factory/blob/main/CLAUDE.md))
spans four recipes. The first is a short prerequisite for every
channel/network-exposed recipe; the other three are deeper reads when
you start composing tools, hooks, and rules.

- [Recipe 00 — Network Security Primer](00-network-security-primer.md) —
  **prerequisite for every channel target** (Slack, Telegram, Discord,
  WhatsApp, iMessage). The universal "authenticate, then classify"
  pattern. Short; read this first.
- [Recipe 14 — Hooks](14-hooks.md) — `PreToolUse` / `PostToolUse`
  policy hooks; the mechanical guardrail under every other layer.
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) —
  the rule-kinds-in-tier-order grammar; why `alwaysDeny` structurally
  beats `alwaysAllow`; concrete `Bash(rm -rf:*)` examples.
- [Recipe 41 — Security Fabric](41-security-fabric.md) — boundary
  classification at every site that ingests external content (MCP,
  sub-agents, channels, federation, skills, compaction, tool results).

The default permission verdict is `ask`, which is safe in a CLI REPL
but **converts to `deny` in non-interactive shapes** (workflow, graph,
channel, batch, managed). If you build a Slack bot in recipe 03
without reading recipe 29, a random user in that Slack channel can ask
the bot to run shell commands on your server — the same kind of
mistake the recipe ordering used to invite. Run `crewhaus doctor
--philosophy-alignment` before any PR that touches a boundary site;
it will fail the build if Pillar 3 has drifted.

---

## Part 00 — Prerequisites (read before channel/network recipes)

Cross-cutting primers that several later recipes assume as background.
Each is shorter than the recipes that depend on it.

| #  | Recipe                                                       | Required by                  | Status   |
| -- | ------------------------------------------------------------ | ---------------------------- | -------- |
| 00 | [Network Security Primer](00-network-security-primer.md)     | Recipes 03, 37, 38, 39, 40   | complete |

## Part A — Target shapes (one recipe per shape)

These walk you through every shape `target:` can take. Each shape is
runnable from a 5–30 line spec and a one-line `bun run …`.

| #  | Recipe                                                   | Shape       | Smallest example                                                  | Status   |
| -- | -------------------------------------------------------- | ----------- | ----------------------------------------------------------------- | -------- |
| 01 | [CLI Coding Agent](01-cli-coding-agent.md)               | `cli`       | [`starters/cli`](../starters/cli)                  | complete |
| 02 | [Sequential Workflow](02-sequential-workflow.md)         | `workflow`  | [`starters/workflow`](../starters/workflow)        | complete |
| 03 | [Slack Bot](03-slack-bot.md)                             | `channel`   | [`starters/channel`](../starters/channel)          | complete |
| 04 | [Multi-Agent Crew](04-multi-agent-crew.md)               | `crew`      | [`starters/crew`](../starters/crew)                | complete |
| 05 | [Stateful Graph](05-stateful-graph.md)                   | `graph`     | [`starters/graph`](../starters/graph)              | complete |
| 06 | [RAG Pipeline](06-rag-pipeline.md)                       | `pipeline`  | [`starters/rag`](../starters/rag)                  | complete |
| 07 | [Autonomous Research](07-autonomous-research.md)         | `research`  | [`starters/research`](../starters/research)        | complete |
| 08 | [Batch Worker](08-batch-worker.md)                       | `batch`     | [`starters/batch`](../starters/batch)              | complete |
| 09 | [Voice Agent](09-voice-agent.md)                         | `voice`     | [`starters/voice`](../starters/voice)              | complete |
| 10 | [Browser Agent](10-browser-agent.md)                     | `browser`   | [`starters/browser`](../starters/browser)          | complete |
| 11 | [Managed Multitenant](11-managed-multitenant.md)         | `managed`   | [`starters/managed`](../starters/managed)          | complete |
| 12 | [Eval Harness](12-eval-harness.md)                       | `eval`      | [`starters/eval`](../starters/eval)                | complete |

## Part B — Core capabilities

Cross-cutting features that compose into every shape.

| #  | Recipe                                                       | Catalog       | Status   |
| -- | ------------------------------------------------------------ | ------------- | -------- |
| 13 | [MCP Servers](13-mcp-servers.md)                             | §9            | complete |
| 14 | [Hooks](14-hooks.md)                                         | §11           | complete |
| 15 | [Skills](15-skills.md)                                       | §11           | complete |
| 16 | [Slash Commands](16-slash-commands.md)                       | §11           | complete |
| 17 | [Observability](17-observability.md)                         | §15, §27, §37 | complete |

## Part C — Production hardening

When you're ready to put an agent in front of paying users.

| #  | Recipe                                                                  | Catalog       |
| -- | ----------------------------------------------------------------------- | ------------- |
| 18 | [Multi-Provider Fallback](18-multi-provider-fallback.md)                | §17, §27      |
| 19 | [Rate Limiting and Budgets](19-rate-limiting-and-budgets.md)            | §27, §20      |
| 20 | [Secrets Management](20-secrets-management.md)                          | §27           |
| 21 | [Deployment and Canary](21-deployment-and-canary.md)                    | §28, §29      |
| 22 | [Compliance and Audit](22-compliance-and-audit.md)                      | §20, §39      |
| 23 | [PII Redaction and Encryption](23-pii-redaction-and-encryption.md)      | §39           |

## Part D — Distribution and ecosystem

Ship the agent to others.

| #  | Recipe                                                               | Catalog   |
| -- | -------------------------------------------------------------------- | --------- |
| 24 | [Docker and Helm](24-docker-and-helm.md)                             | §32       |
| 25 | [VS Code and JetBrains](25-vscode-and-jetbrains.md)                  | §35       |
| 26 | [Template Marketplace](26-template-marketplace.md)                   | §40       |
| 27 | [Federation](27-federation.md)                                       | §34       |

## Part E — Going deeper

Topics that don't fit cleanly above but matter once you start building real systems.

| #  | Recipe                                                                | Catalog   |
| -- | --------------------------------------------------------------------- | --------- |
| 28 | [Sub-agents and the Task Tool](28-sub-agents-and-task.md)             | §13       |
| 29 | [Permissions Deep Dive](29-permissions-deep-dive.md)                  | §7, §13   |
| 30 | [Sandboxed Code Execution](30-sandboxed-code-execution.md)            | §18, §36  |
| 31 | [Session Resume and Replay](31-session-resume-and-replay.md)          | §10, §31  |
| 32 | [Local Models](32-local-models.md)                                    | §17       |
| 33 | [Prompt Caching](33-prompt-caching.md)                                | §27       |
| 34 | [Building Custom Graders](34-building-custom-graders.md)              | §16, §38  |
| 35 | [Studio Walkthrough](35-studio-walkthrough.md)                        | §26, §31  |
| 36 | [Cloud Deploy](36-cloud-deploy.md)                                    | §32       |

## Part F — Channel adapters (one per channel; Slack covered in #3)

Every channel recipe assumes [Recipe 00 — Network Security
Primer](00-network-security-primer.md) as background — the
authenticate-then-classify pattern is identical across channels and
lives there, so the per-channel recipes only cover what differs per
transport.

| #  | Recipe                                                          | Catalog   |
| -- | --------------------------------------------------------------- | --------- |
| 37 | [Channel: Telegram](37-channel-telegram.md)                     | §33       |
| 38 | [Channel: Discord](38-channel-discord.md)                       | §33       |
| 39 | [Channel: WhatsApp](39-channel-whatsapp.md)                     | §33       |
| 40 | [Channel: iMessage](40-channel-imessage.md)                     | §33       |

## Part G — The three architectural pillars (philosophy alignment)

Recipes that map directly onto the invariants codified in [`/CLAUDE.md`](https://github.com/crewhaus/factory/blob/main/CLAUDE.md).

| #  | Recipe                                                          | Pillar             | Status   |
| -- | --------------------------------------------------------------- | ------------------ | -------- |
| 41 | [Security fabric](41-security-fabric.md)                        | Pillar 3 — fabric  | complete |
| 42 | [Active optimization](42-active-optimization.md)                | Pillar 2 — active  | complete |

## Part H — Section 47 blockchain shapes

Recipes covering the §47 blockchain integration. Most blockchain "shapes" from the §47 proposal are compositions of existing IR variants with the cross-cutting `chains` / `wallets` / `contracts` / `transaction_policy` blocks — only the event daemon and game-playing shape needed new IR variants (recipe 47).

| #  | Recipe                                                          | §47 shapes covered           | Status   |
| -- | --------------------------------------------------------------- | ---------------------------- | -------- |
| 43 | [Wallet-gated action](43-wallet-gated-action.md)                | Shapes 1, 11                 | complete |
| 44 | [Chain as tool gateway](44-chain-as-tool-gateway.md)            | Shapes 2, 3, 5, 7            | complete |
| 45 | [DAO governance crew](45-dao-governance-crew.md)                | Shape 6                      | complete |
| 46 | [Tokenized access](46-tokenized-access.md)                      | Shapes 9, 12 (credential)    | complete |
| 47 | [Onchain daemon & game](47-onchain-daemon-and-game.md)          | Shapes 8, 10 + on-chain games | complete |

## Part I — Meta-tooling

Reflexive recipes — CrewHaus designing itself. The system general enough that a YAML spec can produce the harness that writes the YAML.

| #  | Recipe                                                          | Pattern            | Status   |
| -- | --------------------------------------------------------------- | ------------------ | -------- |
| 48 | [Harness Designer](48-harness-designer.md)                      | meta-cli           | complete |

## Part J — Showcase demos (full-power examples)

"Tier-1 mainstream harness" imitations — fork these to start at full power instead of building up from scratch. Each is referenced in §0.5 of the diagnostic tree above and from the top-level [README](../README.md#showcase-demos).

| #  | Recipe                                                          | Imitates                | Status   |
| -- | --------------------------------------------------------------- | ----------------------- | -------- |
| 49 | [Pro-grade Coder](49-procode.md)                                | Claude Code / Cursor    | complete |
| 50 | [Pro-grade Chat](50-prochat.md)                                 | ChatGPT / Claude.ai     | complete |
| 51 | [Multi-channel Personal Assistant](51-multichat.md)             | OpenClaw                | complete |

## Part K — Pillar extensions & corpus integration

Deeper cuts on the Pillar 2 (active eval) and Pillar 3 (security fabric) invariants from [`CLAUDE.md`](https://github.com/crewhaus/factory/blob/main/CLAUDE.md) (read alongside Part G), plus recipes that integrate external corpora (codebases, document stores) into the agent's context.

| #  | Recipe                                                          | Theme                                  | Status   |
| -- | --------------------------------------------------------------- | -------------------------------------- | -------- |
| 52 | [Active Context Curation](52-context-curation.md)               | Pillar 2 — active                       | complete |
| 53 | [Justification Gates](53-justification-gates.md)                | Pillar 3 — intent                       | complete |
| 54 | [Codegraph Tool](54-codegraph-tool.md)                          | Corpus — `@colbymchenry/codegraph`      | complete |
| 55 | [Egress Fabric](55-egress-fabric.md)                            | Pillar 3 — sink side                    | complete |
| 56 | [Response Ratings](56-response-ratings.md)                      | Pillar 2 — ratings → evals              | complete |

---

## Quick paths (for readers who already know the shape they want)

If the diagnostic tree above already pointed you somewhere, you can
skip this section. These are the back-of-the-book index entries — once
you've internalized the topologies, they're the fastest way to wire up
a known scenario:

- **Newcomer.** 01 → 17 → 13 → 14 → 29.
- **Putting an agent in Slack.** 01 → 03 → 14 → 17.
- **Building an internal eval / canary loop.** 12 → 21 → 17 → 34.
- **Shipping a SaaS.** 11 → 19 → 20 → 22 → 23 → 24 → 36.
- **Multi-agent system.** 04 → 28 → 05 → 27.
- **RAG / research.** 06 → 07 → 12.
- **Blockchain integration.** 43 → 44 → 46 → 45 → 47.
- **Active optimization (DSPy-inspired).** 12 → 34 → 42 → 52.
- **Closing the loop from user ratings.** 56 → 12 → 42.
- **Pillar 3 hardening (defense-in-depth).** 29 → 41 → 53 → 55.
- **Forking a tier-1 harness.** 49 (procode) or 50 (prochat) or 51 (multichat) → fork the matching showcase.
- **Designing a new harness from intent.** 48 → (the recipe for the shape it picks) → 12 → 42.

## Module coverage

> **Claim:** every *shipped* (✅) module in the
> [Module Catalog](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md)
> is exercised by at least one recipe above or introduced in
> [GETTING-STARTED.md](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md).
> Unbuilt / experimental modules (the catalog's 🟡 / 🔴 long-tail) are
> reference-only by design — you can't walk through code that doesn't
> ship yet — and are inventoried in
> [MODULE-CATALOG-STATUS.md → Unbuilt module inventory](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG-STATUS.md#unbuilt-module-inventory).

The catalog groups the runtime's ~290 modules into 25 layers (F1–F5
factory-level, R1–R20 runtime). Each layer below names the recipe(s)
that exercise it; **GS** = GETTING-STARTED.md. This table is the inverse
of the per-recipe `Catalog` columns in the Part tables above, and is the
thing to check when asking "is module X covered anywhere?".

### Factory-level layers (the meta-harness itself)

| Layer | What it is | Covered by |
| ----- | ---------- | ---------- |
| **F1** | Spec & IR | GS · 01–12 (every shape compiles a spec) · 42 (`spec-patch`) · 48 |
| **F2** | Compiler & Codegen | GS (the 60-second YAML→TS proof) · 01–12 (one target emitter each) · 48 |
| **F3** | Deployment & Operations | 11 · 21 · 24 · 36 |
| **F4** | Studio & Authoring UX | 25 · 26 · 35 · 48 |
| **F5** | Plugin SDK & Extension | 26 · 35 |

### Runtime layers (the building blocks wired into the bundle)

| Layer | What it is | Covered by |
| ----- | ---------- | ---------- |
| **R1** | Runtime Core (agent loop) | GS (run-time, one turn) · 01 · 31 |
| **R2** | Model Layer | GS · 18 · 32 · 33 |
| **R3** | Tool Layer (core) | GS · 01 · 28 |
| **R4** | Built-in Tools | 01 · 09 · 10 · 30 · 50 · 54 |
| **R5** | MCP & Protocol Hosts | 13 · 27 · 43–47 |
| **R6** | Context & Memory | GS (compaction) · 07 · 52 |
| **R7** | State, Sessions, Persistence | GS (the `.crewhaus/` directory) · 05 · 31 |
| **R8** | Permission, Policy, Safety | 00 · 23 · 29 · 30 · 41 · 46 · 53 · 55 |
| **R9** | Hooks, Skills, Slash Commands | 14 · 15 · 16 |
| **R10** | Multi-Agent / Coordination | 04 · 27 · 28 |
| **R11** | Workflow / Graph / Pipeline Engines | 02 · 05 · 06 |
| **R12** | RAG / Retrieval / Knowledge | 06 · 07 |
| **R13** | Channels & Messaging | 00 · 03 · 37–40 · 51 |
| **R14** | Scheduling & Background | 08 · 19 · 51 |
| **R15** | Telemetry, Tracing, Eval | 12 · 17 · 21 · 34 · 42 · 56 |
| **R16** | UI / TUI / Voice / Media | 09 · 11 · 35 |
| **R17** | Infrastructure & Cross-Cutting | GS · 11 · 20 · 22 |
| **R18** | Specialized / Advanced | 10 · 30 · 54 |
| **R19** | Research-Agent Specific | 07 |
| **R20** | Batch-Worker Specific | 08 |

Every layer resolves to at least one recipe, so no catalog layer is
walkthrough-dark.

### Naming note — brief slug vs catalog/package name

A handful of [module briefs](https://github.com/crewhaus/docs/blob/main/module-briefs/README.md)
use the original planning slug while the current catalog/package ships
under a different name. They're the same module, covered under the
catalog name:

| Brief slug | Catalog / package name | Covered by |
| ---------- | ---------------------- | ---------- |
| `embedding-adapter` | `embedder` | 06 |
| `research-planner` | `planner` | 07 |
| `report-synthesizer` | `report-writer` | 07 |
| `idempotency-store` | `idempotency-keys` | 08 |
| `tool-web-fetch` / `tool-web-search` | `WebFetch` / `WebSearch` (in `tool-web`) | 01 · 50 |
| `tool-team` / `tool-agent` | folded into `tool-task` + `crew-orchestrator` | 04 · 28 |

### Reference-only (no dedicated walkthrough, by design)

- **Unbuilt secondary channel adapters** — `channel-{signal,bluebubbles,email,sms,web}`
  and `channel-imessage-native` are the v1.3 §45 long-tail (🟡 unbuilt).
  The authenticate-then-classify pattern every adapter shares lives in
  [Recipe 00](00-network-security-primer.md); the iMessage host-bridge
  approach is in [Recipe 40](40-channel-imessage.md).
- **§55–§59 integration batch** — `failure-taxonomy`, `meta-harness-optimizer`
  (opt-in / experimental), `contract-compiler`, `specialization-registry`,
  `target-claude-plugin`, and `rules-engine` shipped after the v0.1 recipe
  set. They're documented in
  [MODULE-CATALOG-STATUS.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG-STATUS.md#implementation-summary)
  and are candidates for future recipes.
- **The ~53 unbuilt catalog rows** (R1–R20 🟡 / 🔴) — inventoried in
  [MODULE-CATALOG-STATUS.md → Unbuilt module inventory](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG-STATUS.md#unbuilt-module-inventory).
  None block a shipped target shape.

---

## Status

| Total recipes | Status                  |
| ------------- | ----------------------- |
| 57            | Total (00 prerequisite + 01-40 core + Pillars 41, 42 + §47 recipes 43-47 + meta 48 + showcases 49-51 + Pillar extensions & corpus 52-56) |
| 57            | Walkthrough complete    |
| 0             | Stub                    |

Each recipe walks from "I have an empty workspace" to "I have a
working spec, runnable, with the feature in question exercised." Most
land between 250 and 450 lines of prose, with embedded YAML
snippets and `bun run …` commands that the static validator
re-compiles on every PR.

## Testing recipes

Two scripts validate every walkthrough in `walkthroughs/`:

```bash
bun run walkthroughs:test    # static checks; ~5 seconds
bun run walkthroughs:smoke   # compile + smoke runs; ~10 seconds in CI mode
```

### `walkthroughs:test` — static validation

[`scripts/test-walkthroughs.ts`](../scripts/test-walkthroughs.ts) catches the
bugs human reviewers shouldn't have to:

- **Broken markdown links.** Every relative-path link must resolve to
  a file or directory that exists.
- **Embedded spec YAML.** Every code fence with `yaml` language tag
  that contains both `name:` and `target:` is treated as a complete
  spec and compiled through the in-tree CLI. Drift in the spec schema
  (e.g. renaming `agent.tools` to `tools`) breaks the test instantly.
- **`bun run` references.** Every `bun run <script>` token must
  reference a script that exists in package.json.
- **Frontmatter opt-ins.** Recipes can declare `test.spec`,
  `test.bun_scripts`, and `test.packages` lists for stronger
  validation; the script verifies each.

Runs in well under a second; requires no network or API credentials.

### `walkthroughs:smoke` — compile + run smoke

[`scripts/smoke-walkthroughs.ts`](../scripts/smoke-walkthroughs.ts) actually
runs the `bun_scripts` each recipe declares. Two modes:

- **Default (CI):** runs only `compile:*` scripts. No model calls,
  fast, deterministic. Catches codegen bugs the static check misses
  (e.g. the spec parses but the codegen pipeline rejects it).
- **Live (`RECIPE_SMOKE_LIVE=1`):** also runs `run:*` and `smoke:*`
  scripts. Requires an Anthropic credential and may make billed
  model calls. Run locally before publishing.

### Authoring a testable recipe

Add a `test:` block to the recipe's frontmatter:

```yaml
---
test:
  spec: starters/cli/crewhaus.yaml
  bun_scripts:
    - smoke:section-12     # extra smoke beyond compile/run, if any
  packages:
    - packages/runtime-core
    - packages/target-cli
---
```

The static script validates that the `spec:` path resolves to a real
crewhaus.yaml, that every `bun_scripts:` entry is a defined script
in either repo's package.json, and that every `packages:` path
exists. The smoke script then runs `bun run compile <demo>` derived
from `spec:` (`starters/cli/crewhaus.yaml` → `starters/cli`), and in live
mode also `bun run run <demo>`, plus any extra `bun_scripts:` entries.
The recipe body should reference the same paths so a reader following
along sees what the tests verify.

### CI

[`.github/workflows/walkthroughs.yml`](../.github/workflows/walkthroughs.yml)
runs `walkthroughs:test` on every PR touching `walkthroughs/**`,
`scripts/test-walkthroughs.ts`, or `*/crewhaus.yaml`, followed by
the compile-only `walkthroughs:smoke`. Both must pass before a recipe PR
merges.
