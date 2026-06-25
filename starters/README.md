# starters/

Copy-pasteable spec templates organized by what you're building.

## Layout

```
starters/
├── cli/                first agent — chat REPL with tools (the canonical entry)
├── workflow/           deterministic, sequential, model-driven steps
├── channel/            one generic channel adapter (Slack reference)
├── crew/               multi-role agent crew (researcher/writer/critic, …)
├── graph/              explicit DAG of nodes with typed edges
├── rag/                retrieval-augmented agent over a vector store
├── research/           autonomous sub-question decomposition + synthesis
├── batch/              queue-driven worker; one short job per turn
├── voice/              realtime voice loop (OpenAI Realtime by default)
├── browser/            Chromium-driving agent (screenshot + click + type)
├── managed/            multi-tenant managed agent with per-tenant sessions
├── eval/               eval-stack vertical slice (dataset + graders + report)
├── federation/         cross-deployment role-call protocol (smoke is the demo)
├── harness-designer/   meta-agent that designs other harnesses from intent
├── optimize/           Pillar 2 active eval-driven prompt optimization
│
├── channels/           four platform-specific channel adapter variants
│   ├── discord/
│   ├── imessage/
│   ├── telegram/
│   └── whatsapp/
│
└── showcases/          three "full power" tier-1 harness imitations
    ├── procode/        pro-grade terminal coding companion (Claude Code-style)
    ├── prochat/        pro-grade conversational assistant (ChatGPT-style)
    └── multichat/      always-on multi-channel personal assistant
```

`channel/` (singular) is the generic Slack-targeted channel example;
`channels/` (plural) holds platform-specific variants.

## Usage

Each starter is self-contained. The standard way to run one is from
inside its own directory, with the published CLI (copy the directory
anywhere and it still works):

```bash
cd cli                                  # or any starter directory
bunx crewhaus compile crewhaus.yaml -o dist
bunx crewhaus run crewhaus.yaml         # or: bun dist/agent.ts
```

<details><summary><strong>Contributors</strong> — in-tree dev loop (from the demos repo root)</summary>

```bash
bun run list                 # see every available starter with its target
bun run compile cli          # → starters/cli/dist/agent.ts
bun run run cli              # runs the compiled agent (REPL)
bun run compile channels/discord
bun run compile showcases/procode
```
</details>

Each starter directory has a `crewhaus.yaml` (the spec), a `README.md`
explaining the shape, and a compiled `dist/` output (gitignored).
