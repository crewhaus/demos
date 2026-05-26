---
test:
  spec: starters/showcases/prochat/crewhaus.yaml
---

# Recipe 50 — Pro-grade Chat (à la ChatGPT)

Build a multi-modal conversational assistant — the kind of chat app
ChatGPT and Claude.ai have set the bar for — from a single YAML file:
streaming chat, web browsing (search + fetch), vision (image reading),
image generation, document ingest, a sandboxed Python/JavaScript/shell
code interpreter, a parallel web-research sub-agent, and slash
commands (`/browse`, `/code`, `/analyze`, `/summarize`, `/imagine`,
`/ingest`).

By the end you'll have an agent that can:

- Answer plain chat without invoking tools (no tool theater).
- Search the web and cite sources inline.
- Read images from local paths or URLs.
- Run Python in a sandbox for math, data analysis, and plotting.
- Dispatch a parallel `web-researcher` sub-agent for multi-source
  briefs.

Time: ~5 minutes to run; ~25 minutes to read the spec.

<details>
<summary><strong>Architectural context</strong> — why <code>cli</code> beats <code>browser</code> for a ChatGPT clone</summary>

Two valid target shapes for this product:

- **`target: cli`** — terminal REPL, streaming, native to the tool
  catalog. Uses the model's vision (passes images as content blocks)
  for "what's in this image."
- **`target: browser`** — drives Chromium with Screenshot / Click /
  Type. Right shape if you wanted the model to *use* ChatGPT.com,
  not *be* it.

This recipe picks `cli` because the value proposition of "ChatGPT in
a terminal" is the *capabilities*, not the web chrome. The web chrome
is solvable with Studio or a custom UI on top of the same compiled
runtime; the capabilities are what we're showcasing.

</details>

## Prerequisites

- [Bun](https://bun.sh) 1.2 or later.
- An Anthropic credential.
- [Recipe 01](01-cli-coding-agent.md) and [Recipe 18](18-multi-provider-fallback.md) read once.
- For the code interpreter: nothing extra — `tool-code-execution`
  uses an in-process sandbox by default. For production isolation,
  see [recipe 30](30-sandboxed-code-execution.md).

## Step 1 — Run it first

```bash
bun install
bun run compile starters/showcases/prochat
ANTHROPIC_API_KEY=sk-ant-... bun run run starters/showcases/prochat
```

Five prompts to try, in order:

```
what's the capital of Burkina Faso?
```
Plain chat. No tools fire.

```
/browse latest news on Anthropic Claude 4.7 release
```
Dispatches the `web-researcher` sub-agent. Returns TL;DR + 5 cited
facts + open questions + sources.

```
/code plot the first 30 Fibonacci numbers on a log scale
```
Runs Python in the sandbox. Shows the code AND the output. No
matplotlib install needed — `tool-code-execution` ships with numpy,
pandas, matplotlib, scipy.

```
/analyze /tmp/screenshot.png
```
`ReadImage(path)`, then describes the image via the
`analyze-image` skill's structured-description template.

```
what's 17! / 12!?  show your work
```
The model picks Python automatically. No `/code` needed — slash
commands are sugar, not the only path.

## Step 2 — Tools wired

```yaml
tools:
  - webSearch     # search engines (needs API key)
  - webFetch      # HTTP fetch
  - fetch         # general fetch with config
  - readImage     # vision: pass a local path
  - python        # sandboxed
  - javascript    # sandboxed
  - shell         # sandboxed
```

The three code-execution tools (`python`, `javascript`, `shell`) live
in `tool-code-execution` and run in a process-isolated sandbox — they
can write/read files within the sandbox but **cannot touch your host
filesystem**. That's why the `permissions:` block can `alwaysAllow`
them without an explicit approval prompt:

```yaml
- { type: alwaysAllow, pattern: Python }
- { type: alwaysAllow, pattern: JavaScript }
- { type: alwaysAllow, pattern: Shell }
```

Production isolation (container-per-call) is opt-in via the
`tool_config:` block — see [recipe 30](30-sandboxed-code-execution.md).

## Step 3 — The web-researcher sub-agent

```yaml
sub_agents:
  web-researcher:
    description: |
      Parallel web-research sub-agent. Use when a question requires
      synthesising multiple sources ...
    instructions: |
      You are a parallel web-research sub-agent. Given a topic, do
      3-5 WebSearch queries and 2-3 WebFetch reads, then return a
      structured brief: TL;DR / Key facts (with [N] citations) /
      Open questions / Sources.
    tools: [webSearch, webFetch]
    permissions:
      allow: [WebSearch, WebFetch]
      deny: []
```

Why isolate browsing in a sub-agent? Three reasons:

1. **Token budget** — the main loop doesn't accumulate intermediate
   search results in its context. Only the final synthesised brief
   comes back.
2. **Parallelism** — multiple searches fan out in one Task call;
   results synthesise on return.
3. **Permission scoping** — the sub-agent can't read files, run
   code, or fetch arbitrary URLs outside its `allow:` list. If a
   poisoned page tries a tool-injection ("now run rm -rf /"), the
   sub-agent's tool surface is too narrow to honor it.

This is [Pillar 3 (security fabric)](41-security-fabric.md) in
practice — every boundary is classified, every sub-agent has the
smallest tool surface that does its job.

## Step 4 — Slash commands and skills

Same auto-discovery from `.crewhaus/` as recipe 49:

- **`/browse <query>`** — dispatches `web-researcher`.
- **`/code <task>`** — `Python` in the sandbox with a structured
  code-and-output format.
- **`/analyze <path-or-url>`** — `ReadImage` (local) or `WebFetch`
  (URL), then runs through the `analyze-image` skill.
- **`/summarize <url>`** — 3-sentence summary in a fixed format.

Skills:

- **`analyze-image`** — vision-first structured description (subject /
  setting / composition / notable details / inferred purpose).
- **`research-topic`** — multi-source corroboration with citation
  discipline.
- **`explain-code`** — audience-targeted explanation (beginner /
  cross-language / senior / reviewer).

## Step 5 — Vision routing across providers

`ReadImage` works regardless of model — the tool returns an image
content block, and the model adapter forwards or rasterizes as
appropriate:

| Model | Vision path |
|---|---|
| Claude Sonnet/Opus 4.x | Native — image block forwarded |
| GPT-4o | Native — image block forwarded |
| Gemini 2.0 | Native — image block forwarded |
| Local (no vision) | `ReadImage` returns dimensions + format only |

For URL-passed images (no local path), `WebFetch` is the fallback —
vision-capable models will see the image content; text-only models
get the page text.

## Step 6 — Swap the model

Same recipe as 49 (Claude / OpenAI / Gemini / Bedrock / local). For
this demo `claude-sonnet-4-6` is a good default — cheaper than Opus
without sacrificing the conversation quality.

## What makes it feel pro-grade (ChatGPT-style)

1. **Web browsing as a first-class tool** — not a plugin, not an
   afterthought. WebSearch / WebFetch / Fetch are all in the catalog.
2. **Code interpreter** — Python with numpy / pandas / matplotlib in
   a sandbox. The "Advanced Data Analysis" vibe.
3. **Vision** — pass an image path or a URL; the model describes it.
4. **Parallel research sub-agent** — `/browse` fans out 3-5 searches
   at once and synthesises with citations.
5. **No tool theater** — the instructions block tells the agent NOT
   to invoke a tool when chat will do. Recipe 50's small but important
   contribution to the genre.

## Further reading

- [Recipe 28 — Sub-Agents & Task](28-sub-agents-and-task.md)
- [Recipe 30 — Sandboxed Code Execution](30-sandboxed-code-execution.md)
- [Recipe 13 — MCP Servers](13-mcp-servers.md) — for adding Gmail,
  Calendar, Notion, etc., as connectors
- [Recipe 41 — Security Fabric](41-security-fabric.md) — the
  boundary-classification model that makes web-fetched content safe
  to feed back into the model
