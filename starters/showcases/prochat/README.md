# hello-prochat — a pro-grade conversational assistant in one YAML

A multi-modal chat agent — web search, page fetch, image reading,
image generation, document ingest, a sandboxed code interpreter, and a
parallel web-research sub-agent — compiled from a single
[`crewhaus.yaml`](crewhaus.yaml). Feels tier-one (think ChatGPT /
Claude.ai) in a terminal and runs against **any model** (Claude,
GPT-4o, Gemini, Bedrock, local) — see [Swap the model](#swap-the-model)
below.

## Before you run it

Three of the capabilities above need more than your model key, and each
fails at the first call if you skip its prerequisite. Everything else —
chat, page fetch, vision, document ingest, the sub-agent, compaction —
runs on the model key alone.

**1. A container runtime — for the code interpreter.** `Python`,
`JavaScript` and `Shell` are not evaluated in-process. `@crewhaus/sandbox`
runs every call as a throwaway container:

```
docker run --rm -i --network=none --memory=… --cpus=… --read-only \
  --tmpfs /tmp:rw,size=64m --security-opt no-new-privileges <image> …
```

So start Docker (or Podman — then set `CREWHAUS_SANDBOX=podman`), and
pre-pull the three pinned images, because the first uncached call blocks
on a multi-hundred-megabyte pull:

```bash
crewhaus sandbox doctor --probe
```
```
registered sandbox images:
  ✓ javascript node:22-alpine               last healthy 2026-07-25T18:10:05.026Z
  ✓ python     python:3.13-slim             last healthy 2026-07-25T18:10:04.623Z
  ✓ shell      alpine:3.19                  last healthy 2026-07-25T18:10:05.309Z
```

Three ✓ and you're ready. A ✗ means the backend isn't reachable, and every
code-execution call will error until it is — `sandbox doctor` exits 0
either way, so read the marks, not the exit code. `CREWHAUS_SANDBOX=noop`
turns code execution off deliberately instead of failing at first call.
With `CREWHAUS_SANDBOX` unset the REPL boots anyway and prints
`[sandbox] assuming docker …` just above `agent ready`.

The images are pinned by `@crewhaus/tool-code-execution` and **cannot be
changed from the spec** (the parser rejects sandbox-boundary keys by
design). Python is therefore `python:3.13-slim` — the **standard library
only**. numpy, pandas, matplotlib, scipy and requests are not installed,
and `--network=none` means they cannot be installed at call time. Ask for
a chart and you get an ASCII one; that is the honest ceiling of this
sandbox.

**2. `OPENAI_API_KEY` — for `/imagine`.** `ImageGenerate` resolves to the
OpenAI provider whether or not a key is present, so **with no key it
errors** — there is no built-in placeholder:

```
OPENAI_API_KEY is not set — required for provider=openai.
Set the env var or switch to provider=mock for offline testing.
```

For an offline demo, launch with `CREWHAUS_IMAGE_PROVIDER=mock` and the
tool returns a text stub instead. That is a launch-time choice, not a
default.

**3. A search provider — for `WebSearch` and `/browse`.** `WebSearch`
dispatches to Brave or Tavily and needs both env vars:

```bash
export CREWHAUS_SEARCH_PROVIDER=brave    # or: tavily
export CREWHAUS_SEARCH_API_KEY=...
```

Without them the tool returns `WebSearch unavailable: set
CREWHAUS_SEARCH_PROVIDER (brave|tavily) and CREWHAUS_SEARCH_API_KEY in
the environment.` — a string, not a throw, so the model sees it and (per
the spec's rules) says so instead of answering from training data.
`WebFetch` and `Fetch` need no credentials, so `/summarize <url>` and
`/analyze <url>` work without this.

## Run it

```bash
cd starters/showcases/prochat          # if copied elsewhere, cd into that copy
ANTHROPIC_API_KEY=sk-ant-... bunx crewhaus run crewhaus.yaml  # opens REPL
```

Or compile a standalone bundle and run that instead:

```bash
bunx crewhaus compile crewhaus.yaml -o dist --check   # agent.ts + package.json + deps
ANTHROPIC_API_KEY=sk-ant-... bun dist/agent.ts
```

`--check` is the part that matters: on crewhaus 0.4.0 a plain
`compile -o dist` emits only `agent.ts` and `README.md`, with no
`package.json`, so the bundle cannot resolve its own `@crewhaus/*`
imports. `--check` writes the pinned manifest, installs the deps, and
boots the result before handing it to you.

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
Needs `CREWHAUS_SEARCH_PROVIDER` + `CREWHAUS_SEARCH_API_KEY` — see
[Before you run it](#before-you-run-it).

```
/code the first 30 Fibonacci numbers as an ASCII bar chart, log scale
```
Runs Python in the container sandbox. You'll see the script AND its
stdout. Standard library only — ask for a PNG and there's no matplotlib
to draw it with, which is why the prompt asks for ASCII.

```
/analyze /tmp/screenshot.png
```
Reads an image from your filesystem and describes it. (Works with any
absolute or relative path the agent can reach.)

```
/imagine a lobster wearing a top hat, oil-painting style
```
Generates an image via DALL-E. Returns a URL (or a base64 data URI if you
ask for `responseFormat: "b64_json"`). Needs `OPENAI_API_KEY` — see
[Before you run it](#before-you-run-it); with no key the agent relays the
tool's error rather than inventing a placeholder.

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
| Anthropic (default) | `claude-sonnet-5` | `ANTHROPIC_API_KEY` |
| Anthropic (best) | `claude-opus-5` | `ANTHROPIC_API_KEY` |
| Anthropic (cheap) | `claude-haiku-4-5-20251001` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-4o-2024-11-20` | `OPENAI_API_KEY` |
| Google | `gemini-2.0-flash` | `GOOGLE_API_KEY` |
| AWS Bedrock | `bedrock/anthropic.claude-sonnet-4-20250514-v1:0` | `AWS_*` |
| Local (OpenAI-compatible) | `local/llama-3.3-70b@http://localhost:8080/v1` | — |

`crewhaus run` compiles in memory, so it picks up spec edits on the next
launch. If you're running the emitted bundle instead, recompile with
`bunx crewhaus compile crewhaus.yaml -o dist --check`.

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
- R8 `permission-engine` + `sandbox` — the code-execution tools are
  `alwaysAllow` because their isolation is a container, not a trust
  decision; the user's host fs and shell are unreachable from them
- R9 `slash-commands`, `skills-registry` (auto-discovered from
  `.crewhaus/`)
- R13 `sub-agent-spawner` — `web-researcher` dispatches in parallel for
  multi-source synthesis
- R17 `compaction-autocompact` — Haiku summarises older turns

## What makes it feel pro-grade (ChatGPT-style)

- **Web browsing built-in** — Search + fetch are first-class tools, not
  a plugin. Citations are part of the prompt contract. Fetch is
  credential-free; search needs a Brave or Tavily key.
- **Code interpreter / advanced data analysis** — Python, JavaScript and
  shell each run in their own throwaway container, network off and root
  filesystem read-only. The model can do math, parse data and write quick
  scripts without touching your host. The trade: it needs a container
  runtime, and the Python image is stdlib-only.
- **Image generation** — `/imagine` calls DALL-E through
  `OPENAI_API_KEY`. Offline, launch with `CREWHAUS_IMAGE_PROVIDER=mock`
  for a text stub; unset, the tool errors rather than pretending.
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
