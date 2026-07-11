#!/usr/bin/env bun
/**
 * thredz-mcp — a zero-dependency stdio MCP server that gives a CrewHaus
 * agent long-term memory backed by the Thredz wiki (https://thredz.crewhaus.ai).
 *
 * It speaks the Model Context Protocol over newline-delimited JSON-RPC on
 * stdio — the exact transport `@crewhaus/mcp-host` connects with — so the
 * whole thing is one file with no npm install. The crewhaus runtime spawns
 * it (see `mcp_servers.thredz` in ../crewhaus.yaml), lists its tools, and
 * exposes them to the model as `thredz__<tool>`.
 *
 * The tools map onto the Thredz REST API:
 *   recall  →  GET  /wiki/context           (combined text + semantic bundle)
 *   semantic→  POST /wiki/search/semantic    (vector recall)
 *   search  →  GET  /wiki/search             (keyword recall)
 *   get     →  GET  /wiki/articles/{slug}    (read one article in full)
 *   write   →  POST/PATCH /wiki/articles     (UPSERT a durable article by slug)
 *   list    →  GET  /wiki/articles           (enumerate / filter — reflection)
 *   related →  GET  /wiki/articles/{slug}/related   (neighbours — dedup/contradiction)
 *   signals →  PATCH /wiki/articles/{slug}/signals  (verified / confidenceScore)
 *   stats   →  GET  /wiki/stats              (corpus health)
 *   gap     →  POST /tasks                    (log a knowledge gap as a Thredz task)
 *
 * Config (read from the environment; Bun auto-loads ../.env from the harness
 * cwd, so putting THREDZ_API_KEY in starters/expert/.env is enough):
 *   THREDZ_API_KEY   required — a Bearer key with a wiki grant
 *   THREDZ_API_BASE  optional — default https://thredz.crewhaus.ai/api
 *
 * IMPORTANT: stdout carries ONLY JSON-RPC frames. Everything diagnostic goes
 * to stderr, or the MCP handshake breaks.
 */

const API_BASE = (process.env.THREDZ_API_BASE ?? "https://thredz.crewhaus.ai/api").replace(/\/+$/, "");
const WIKI_BASE = `${API_BASE}/wiki`;
const API_KEY = process.env.THREDZ_API_KEY ?? "";

const log = (...a: unknown[]) => process.stderr.write(`[thredz-mcp] ${a.join(" ")}\n`);

// ── HTTP helper ────────────────────────────────────────────────────────────
type Json = Record<string, unknown>;

async function thredz(
  method: string,
  path: string,
  opts: { query?: Record<string, unknown>; body?: Json } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  if (!API_KEY) {
    return { ok: false, status: 0, data: { error: "THREDZ_API_KEY is not set — put it in starters/expert/.env" } };
  }
  const url = new URL(path.startsWith("http") ? path : `${API_BASE}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "x-api-key": API_KEY, // compat header, harmless alongside Authorization
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    return { ok: false, status: 0, data: { error: `network error reaching ${url.host}: ${(err as Error).message}` } };
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* leave as text */
  }
  return { ok: res.ok, status: res.status, data };
}

// ── Tool implementations ────────────────────────────────────────────────────
type ToolResult = { text: string; isError?: boolean };

function present(label: string, r: { ok: boolean; status: number; data: unknown }): ToolResult {
  const body = typeof r.data === "string" ? r.data : JSON.stringify(r.data, null, 2);
  if (!r.ok) return { text: `${label} failed (HTTP ${r.status}):\n${body}`, isError: true };
  return { text: body };
}

const handlers: Record<string, (args: Json) => Promise<ToolResult>> = {
  // --- Recall (what the agent calls on every query) ---
  async wiki_recall(a) {
    const r = await thredz("GET", "/wiki/context", { query: { q: a.query, limit: a.limit ?? 6 } });
    return present("wiki_recall", r);
  },
  async wiki_semantic_search(a) {
    const r = await thredz("POST", "/wiki/search/semantic", {
      body: { query: a.query, limit: a.limit ?? 6, minScore: a.minScore ?? 0.05 },
    });
    return present("wiki_semantic_search", r);
  },
  async wiki_search(a) {
    const r = await thredz("GET", "/wiki/search", { query: { q: a.query } });
    return present("wiki_search", r);
  },
  async wiki_get(a) {
    const r = await thredz("GET", `/wiki/articles/${encodeURIComponent(String(a.slug))}`, {
      query: { concise: a.concise ?? undefined },
    });
    return present("wiki_get", r);
  },

  // --- Write (durable memory; UPSERT by slug) ---
  async wiki_write(a) {
    const slug = String(a.slug ?? "").trim();
    if (!slug) return { text: "wiki_write requires a `slug`", isError: true };
    const fields: Json = {
      title: a.title,
      slug,
      body: a.body,
      summary: a.summary,
      tags: a.tags,
      category: a.category,
      status: a.status ?? "published",
      confidenceScore: a.confidenceScore,
      editMessage: a.editMessage ?? "agent update",
    };
    // Upsert: does the slug already exist?
    const existing = await thredz("GET", `/wiki/articles/${encodeURIComponent(slug)}`, {
      query: { fields: "id,slug,version" },
    });
    if (existing.ok) {
      // The article may be returned bare or wrapped as { article: {...} };
      // `version` is required for the PATCH optimistic-concurrency check.
      const doc = (existing.data as Json) ?? {};
      const art = ((doc.article as Json) ?? doc) as Json;
      const version = art.version;
      const r = await thredz("PATCH", `/wiki/articles/${encodeURIComponent(slug)}`, {
        body: { ...fields, version },
      });
      return present(`wiki_write (updated ${slug})`, r);
    }
    const r = await thredz("POST", "/wiki/articles", { body: fields });
    return present(`wiki_write (created ${slug})`, r);
  },

  // --- Reflection helpers ---
  async wiki_list(a) {
    const r = await thredz("GET", "/wiki/articles", {
      query: {
        q: a.query,
        tags: a.tags,
        category: a.category,
        status: a.status,
        sort: a.sort ?? "updated",
        order: a.order ?? "asc",
        limit: a.limit ?? 25,
        fields: "slug,title,tags,updatedAt,daysSinceUpdate,verified,confidenceScore,version",
      },
    });
    return present("wiki_list", r);
  },
  async wiki_related(a) {
    const r = await thredz("GET", `/wiki/articles/${encodeURIComponent(String(a.slug))}/related`);
    return present("wiki_related", r);
  },
  async wiki_set_signals(a) {
    const body: Json = {};
    if (a.verified !== undefined) body.verified = a.verified;
    if (a.confidenceScore !== undefined) body.confidenceScore = a.confidenceScore;
    const r = await thredz("PATCH", `/wiki/articles/${encodeURIComponent(String(a.slug))}/signals`, { body });
    return present("wiki_set_signals", r);
  },
  async wiki_stats() {
    const r = await thredz("GET", "/wiki/stats");
    return present("wiki_stats", r);
  },

  // --- Knowledge-gap logging (drives "learn what to learn") ---
  async log_knowledge_gap(a) {
    const r = await thredz("POST", "/tasks", {
      body: {
        title: `Study gap: ${a.topic}`,
        description: a.detail ?? `Low-confidence answer encountered. Prioritise learning: ${a.topic}`,
        tags: ["knowledge-gap", ...(Array.isArray(a.tags) ? (a.tags as string[]) : [])],
        priority: a.priority ?? "medium",
      },
    });
    return present("log_knowledge_gap", r);
  },
};

// ── Tool schemas advertised to the model ────────────────────────────────────
const s = (props: Json, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });

const TOOLS = [
  {
    name: "wiki_recall",
    description:
      "PRIMARY RECALL. Fetch the most relevant slice of the expert's own wiki for a query — a combined keyword + semantic-vector context bundle. Call this FIRST on every user question before answering.",
    inputSchema: s({ query: str("what to recall about"), limit: num("max snippets (default 6)") }, ["query"]),
  },
  {
    name: "wiki_semantic_search",
    description: "Vector/semantic search over the wiki. Use when a query is conceptual and keyword search would miss paraphrases.",
    inputSchema: s({ query: str("natural-language query"), limit: num("max results (default 6)"), minScore: num("similarity floor 0–1 (default 0.05)") }, ["query"]),
  },
  {
    name: "wiki_search",
    description: "Keyword/full-text search over the wiki with scored snippets. Use for exact terms, names, numbers.",
    inputSchema: s({ query: str("keyword query") }, ["query"]),
  },
  {
    name: "wiki_get",
    description: "Read one wiki article in full by its slug (e.g. after a search returns a promising hit).",
    inputSchema: s({ slug: str("article slug"), concise: bool("trim to essentials") }, ["slug"]),
  },
  {
    name: "wiki_write",
    description:
      "UPSERT a durable article into the wiki by slug (creates, or patches the existing one). This is how the expert commits time-tested, high-value knowledge to long-term memory. Include sources and a confidenceScore.",
    inputSchema: s(
      {
        slug: str("stable kebab-case identifier"),
        title: str("article title"),
        body: str("Markdown body — include a ## Sources section with citations"),
        summary: str("one-line summary"),
        tags: { type: "array", items: { type: "string" }, description: "lowercase topic tags" },
        category: str("category slug (optional)"),
        status: str("draft | published | review | archived (default published)"),
        confidenceScore: num("0–1 confidence in this knowledge"),
        editMessage: str("what changed and why"),
      },
      ["slug", "title", "body"],
    ),
  },
  {
    name: "wiki_list",
    description:
      "List/filter wiki articles. For REFLECTION passes: sort by `updated` ascending to surface the stalest articles, or filter by tags/status to audit a topic.",
    inputSchema: s({
      query: str("optional relevance filter"),
      tags: str("comma-separated tags"),
      category: str("category slug"),
      status: str("draft | published | review | archived | all"),
      sort: str("updated | created | title | relevance | popular | trending"),
      order: str("asc | desc"),
      limit: num("page size (default 25, max 100)"),
    }),
  },
  {
    name: "wiki_related",
    description: "Find articles related to a slug by tags + semantic similarity. Use in reflection to detect duplicates or contradictions to reconcile.",
    inputSchema: s({ slug: str("article slug") }, ["slug"]),
  },
  {
    name: "wiki_set_signals",
    description:
      "Set quality signals on an article after verification: `verified` (fact-checked against a primary source) and/or `confidenceScore` (0–1). Use in reflection to promote or demote knowledge.",
    inputSchema: s({ slug: str("article slug"), verified: bool("fact-checked"), confidenceScore: num("0–1") }, ["slug"]),
  },
  {
    name: "wiki_stats",
    description: "Corpus health: article/category/tag/version counts. Useful in a reflection summary.",
    inputSchema: s({}),
  },
  {
    name: "log_knowledge_gap",
    description:
      "Record a knowledge gap as a Thredz task when the expert could NOT confidently answer. These gaps become the highest-priority items for the next study pass — this is how the expert learns WHAT to learn.",
    inputSchema: s({ topic: str("the topic the expert was weak on"), detail: str("what specifically was missing"), tags: { type: "array", items: { type: "string" } }, priority: str("low | medium | high") }, ["topic"]),
  },
];

// ── JSON-RPC / MCP wire loop ─────────────────────────────────────────────────
function send(msg: Json) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id: unknown, result: Json) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id: unknown, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg: Json): Promise<void> {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };
  if (method === undefined) return; // a response to us — ignore
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const clientProto = (params?.protocolVersion as string) ?? "2024-11-05";
      reply(id, {
        protocolVersion: clientProto,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "thredz", version: "0.1.0" },
      });
      return;
    }
    case "notifications/initialized":
      return; // notification, no reply
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name as string;
      const args = (params?.arguments as Json) ?? {};
      const fn = handlers[name];
      if (!fn) {
        reply(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
        return;
      }
      try {
        const out = await fn(args);
        reply(id, { content: [{ type: "text", text: out.text }], isError: out.isError ?? false });
      } catch (err) {
        reply(id, { content: [{ type: "text", text: `Tool ${name} threw: ${(err as Error).message}` }], isError: true });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

async function main() {
  log(`ready — API_BASE=${API_BASE} key=${API_KEY ? "set" : "MISSING"}`);
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        log(`skip non-JSON line: ${line.slice(0, 80)}`);
        continue;
      }
      // Don't await serially-block the read loop on slow HTTP; but ordering of
      // replies isn't required by JSON-RPC (id-matched), so fire-and-forget.
      void handle(msg);
    }
  }
}

main().catch((err) => {
  log(`fatal: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
