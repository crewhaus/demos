# Recipe 54 — `tool-codegraph` (AST-aware code intelligence)

CrewHaus's default code-exploration tools — `tool-fs.Read`, `Grep`, `Glob` — are byte-level. They work, but they cost tool calls and they re-resolve definitions every time. For agents operating on user codebases (a crew running a refactor, a research bundle auditing a repo, a managed agent answering "what does this function do?"), this dominates the wall-clock and the model context.

[`@colbymchenry/codegraph`](https://www.npmjs.com/package/@colbymchenry/codegraph) is a local-first AST knowledge graph: tree-sitter parses each source file, the symbols and edges land in SQLite, and a query API exposes search / callers / callees / impact-radius. The project's benchmarks show **94% fewer tool calls** and **77% faster agent reasoning** than the grep+find baseline.

`@crewhaus/tool-codegraph` wraps the SDK as four tools an agent can register and call.

## What this recipe covers

- Installing the optional peer (`@colbymchenry/codegraph`)
- Registering the four tools in a spec
- The agent's experience using them
- Mock injection for tests (no real SDK needed)
- Pairing with `target-crew` for refactor agents

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop and tool-registration semantics.
- [Recipe 28 — Sub-agents and the Task Tool](28-sub-agents-and-task.md)
  — codegraph is most useful inside crew or refactor sub-agents that
  scan large codebases on the parent's behalf.
- The optional `@colbymchenry/codegraph` peer dependency (the
  installing section below shows the one-line `bun add` + index step).

## Installing

The codegraph SDK is an *optional* peer dependency — CrewHaus targets that don't need code intelligence (`channel`, `voice`, `eval`) shouldn't be forced to install it.

```bash
# In your CrewHaus project directory:
bun add @colbymchenry/codegraph

# Index the codebase you want the agent to query:
bunx codegraph init
bunx codegraph index
```

That creates a `.codegraph/index.db` SQLite database in the cwd. The four tools auto-discover it.

## Wiring in a spec

```yaml
# spec.yaml
name: refactor-helper
target: crew
model: claude-sonnet-4-6
entry: refactor-helper
roles:
  refactor-helper:
    instructions: |
      You help senior engineers reason about code changes. Use CodeGraph tools to
      answer "what calls this?" and "what's the blast radius of this change?"
      before suggesting any refactor.
    tools:
      - codegraphSearch
      - codegraphCallers
      - codegraphCallees
      - codegraphImpact
      # Also useful in combination:
      - read
      - grep
```

All four tools are `scope: "internal"` — the egress classifier short-circuits them, so they run at full speed.

## What the agent does with them

A reasonably-trained agent will follow a pattern like:

1. `CodeGraphSearch({ query: "parseSpec", limit: 5 })` — find where the symbol is defined.
2. `Read` the file at the returned path to see the definition.
3. `CodeGraphCallers({ symbol: "parseSpec" })` — see what depends on it.
4. `CodeGraphImpact({ symbol: "parseSpec" })` — quantify the blast radius.
5. *Only now* propose a change.

Compare with the baseline: `Grep("parseSpec", "src/")` then `Read` every hit looking for definitions vs. uses. The codegraph path is 1 specific tool call + 1 read; the grep path is 1 broad grep + N reads.

## Test patterns

The package exposes `_injectCodeGraphFactory` so unit tests can supply a mock client without touching the SDK or filesystem:

```typescript
import { _injectCodeGraphFactory, codegraphSearch } from "@crewhaus/tool-codegraph";

_injectCodeGraphFactory(async () => ({
  searchNodes: async (q) => [
    { name: "parseSpec", kind: "function", file: "src/spec.ts", line: 42 },
  ],
  getCallers: async () => [],
  getCallees: async () => [],
  getImpactRadius: async () => ({ direct: 0, transitive: 0 }),
}));

const out = await codegraphSearch.execute({ query: "parseSpec", limit: 10 });
```

The mock injector is cleared between tests via `_injectCodeGraphFactory(undefined)` in an `afterEach`.

## When NOT to use codegraph

- The spec doesn't operate on a single user codebase (multi-tenant agent platforms, voice/realtime agents).
- The user's codebase is < 50 files. Tree-sitter indexing overhead may exceed the savings.
- The agent needs string-level semantics codegraph doesn't capture (comments, docstrings, README content). Use `Grep` + `Read` for that and reserve codegraph for symbol-level queries.

## Pairing with the security fabric

`tool-codegraph` reads from the local SQLite index. Its outputs are file paths, line numbers, and short snippets — all tagged as `"tool"` origin by the post-tool boundary classifier per recipe 41. When that content later flows into a tool with `scope: "external"`, the egress fabric (recipe 55) detects the exfil risk if it appears verbatim in an outbound payload.

A common safe pattern: codegraph's output is summarized by the model before any external transmission, so verbatim filenames don't appear in URLs or messages. Curate this with the egress fabric's `egressOverride: { tool: "pass" }` when the user's spec explicitly wants codegraph output in outbound channels (e.g., a Slack bot that says "the change touches src/spec.ts:42").

## Implementation pointers

- New package: [packages/tool-codegraph/](../../factory/packages/tool-codegraph/)
- Optional peer: `@colbymchenry/codegraph`
- Reference implementation: `ref/codegraph-main/` (vendored upstream copy)
- Test seam: `_injectCodeGraphFactory(factory)`

## Further reading

- [codegraph GitHub](https://github.com/colbymchenry/codegraph) — upstream project
- [recipe 41-security-fabric.md](41-security-fabric.md) — source-side classification of tool output
- [recipe 55-egress-fabric.md](55-egress-fabric.md) — sink-side check when codegraph content reaches an external tool
