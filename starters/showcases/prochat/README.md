# hello-prochat — a pro-grade conversational assistant in one YAML

A multi-modal chat agent — web search, page fetch, image reading,
image generation, document ingest, a sandboxed code interpreter, and a
parallel web-research sub-agent — compiled from a single
[`crewhaus.yaml`](crewhaus.yaml). Feels tier-one (think ChatGPT /
Claude.ai) in a terminal and runs against **any model** (Claude,
GPT-4o, Gemini, Bedrock, local) — see [Swap the model](#swap-the-model)
below.

## Run it

```bash
cd starters/showcases/prochat          # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist            # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-ant-... bunx crewhaus run crewhaus.yaml  # opens REPL
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile showcases/prochat
bun run run showcases/prochat
```
</details>

## Try this

Open the REPL, then paste one of these:

```
what's the capital of Burkina Faso?
```
Plain chat — no tools fire. The model just answers.

```
/browse latest news on Anthropic Claude 4.7 release
```
Dispatches the `web-researcher` sub-agent for parallel browsing.
Returns a TL;DR, 5 cited facts, open questions, and a sources list.

```
/code plot the first 30 Fibonacci numbers as a bar chart, log scale
```
Runs Python in the sandbox. You'll see the code AND the rendered
output description.

```
/analyze /tmp/screenshot.png
```
Reads an image from your filesystem and describes it. (Works with any
absolute or relative path the agent can reach.)

```
/imagine a lobster wearing a top hat, oil-painting style
```
Generates an image via DALL-E (or your configured provider). Returns a
URL (or base64 data URI for offline / no-CDN setups).

```
/ingest ~/Documents/notes.md
```
Reads a document from disk with structured metadata. Built-in support
for .txt/.md/.csv/.json/.yaml; PDF/docx/xlsx via operator-registered
parsers (see `@crewhaus/tool-document-ingest`).

```
what's 17! / 12!? show your work
```
The model picks Python automatically — `/code` is optional, not
required. Watching the model decide is part of the demo.

```
/summarize https://en.wikipedia.org/wiki/Burkina_Faso
```
Fetches the URL and returns a 3-sentence summary.

## Swap the model

The `model:` field is a provider-prefixed string. Edit
[`crewhaus.yaml`](crewhaus.yaml) at `agent.model:` to switch:

| Provider | `model:` value | Env var |
|---|---|---|
| Anthropic (default) | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| Anthropic (best) | `claude-opus-4-7` | `ANTHROPIC_API_KEY` |
| Anthropic (cheap) | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-4o-2024-11-20` | `OPENAI_API_KEY` |
| Google | `gemini-2.0-flash` | `GOOGLE_API_KEY` |
| AWS Bedrock | `bedrock/anthropic.claude-sonnet-4-20250514-v1:0` | `AWS_*` |
| Local (OpenAI-compatible) | `local/llama-3.3-70b@http://localhost:8080/v1` | — |

Recompile (`bunx crewhaus compile crewhaus.yaml -o dist`) after any change to the spec.

> **Vision note**: `ReadImage` works on any model. For URL-fetched
> images, vision-capable models (GPT-4o, Claude Sonnet/Opus, Gemini)
> see the image inline; text-only local models will only see a textual
> description from `WebFetch`.

## What this slice exercises

Catalog modules touched (per factory's
[docs/MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):

- F1 `spec-schema`, `spec-parser`, `spec-validator`, `ir-model`
- F2 `compiler-core`, `target-cli-bundle`, `codegen-templates`
- R1 `runtime-orchestrator` (streaming chat loop)
- R2 `model-adapter` (provider-agnostic; vision routing)
- R3 `tool-catalog` (webSearch, webFetch, fetch, readImage,
  imageGenerate, ingestDocument, python, javascript, shell)
- R8 `permission-engine` — code-execution tools self-sandbox so they're
  `alwaysAllow`; the user's host is not at risk
- R9 `slash-commands`, `skills-registry` (auto-discovered from
  `.crewhaus/`)
- R13 `sub-agent-spawner` — `web-researcher` dispatches in parallel for
  multi-source synthesis
- R17 `compaction-autocompact` — Haiku summarises older turns

## What makes it feel pro-grade (ChatGPT-style)

- **Web browsing built-in** — Search + fetch are first-class tools, not
  a plugin. Citations are part of the prompt contract.
- **Code interpreter / advanced data analysis** — Python, JavaScript,
  and shell run in `tool-code-execution`'s isolated sandbox. The model
  can do math, parse data, plot charts, and write quick scripts without
  touching your host.
- **Image generation** — `/imagine` calls DALL-E (or any configured
  provider). Mock-fallback when no API key is set keeps the demo
  testable offline.
- **Document ingest** — `/ingest` reads txt/md/csv/json/yaml inline;
  pluggable parsers for PDF/docx/xlsx.
- **Vision** — Pass a screenshot path or a URL and the model describes
  what it sees (on vision-capable models).
- **Parallel research sub-agent** — `/browse` fans out across 3-5
  searches at once, then synthesises with citations.

## Fork and extend

Three high-leverage extensions:

1. **Add knowledge** — wire in a `pipeline`-target RAG over your
   personal documents (see
   [`hello-rag`](https://github.com/crewhaus/demos/blob/main/starters/rag/)) and use the `Retrieve` tool here too.
2. **Add an MCP connector** — `mcp_servers:` in the YAML for Gmail,
   Drive, calendar, Linear, GitHub, etc. New tools appear as
   `<server>__<tool>` automatically.
3. **Make it a Slack bot** — change `target: cli` to `target: channel`,
   wire up `channels.slack`, recompile. Same prompt, different
   surface — the value proposition of the CrewHaus compiler.

See [`hello-procode`](https://github.com/crewhaus/demos/blob/main/starters/showcases/procode/) for the sibling pro-grade
coding companion and [`hello-multichat`](https://github.com/crewhaus/demos/blob/main/starters/showcases/multichat/) for the
multi-channel always-on personal assistant.
