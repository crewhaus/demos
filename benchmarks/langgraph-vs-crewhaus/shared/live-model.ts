/**
 * Live-model helper shared by both hand-built LangGraph workloads.
 *
 * Discovers credentials + a default model from, in order:
 *   1. process.env (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN, CLOUD_DEMO_MODEL)
 *   2. demos/.env
 *   3. factory/.env
 *   4. CrewHaus/.env  (repo root, one level above public/)
 *
 * If a usable credential is found it calls the Anthropic Messages API directly
 * (no SDK dependency) and returns real token usage. If none is found, or the
 * call fails, it returns { ok: false, reason } — callers fall back to an
 * offline path and the benchmark records the live figure as "not obtained".
 *
 * NOTHING here fabricates token counts or latency: usage is read straight off
 * the API response.
 */
import { existsSync, readFileSync } from "node:fs";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ModelOk = {
  ok: true;
  text: string;
  usage: { input: number; output: number };
  model: string;
  latencyMs: number;
};
export type ModelErr = { ok: false; reason: string };
export type ModelResult = ModelOk | ModelErr;

const DEFAULT_MODEL = "claude-sonnet-4-6";

// Candidate .env files, relative to this file at
// demos/benchmarks/langgraph-vs-crewhaus/shared/live-model.ts
const ENV_CANDIDATES = [
  new URL("../../../.env", import.meta.url).pathname, // demos/.env
  new URL("../../../../factory/.env", import.meta.url).pathname, // factory/.env
  new URL("../../../../../.env", import.meta.url).pathname, // CrewHaus/.env (repo root, parent of public/)
];

/** Parse a dotenv file into a flat record, skipping comments and blanks. */
function parseDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key !== "" && val !== "") out[key] = val;
  }
  return out;
}

export type Credentials = {
  apiKey?: string;
  authToken?: string;
  baseUrl: string;
  model: string;
  source: string;
};

let cached: Credentials | undefined;

/** Resolve credentials once, layering process.env over the .env files. */
export function discoverCredentials(): Credentials {
  if (cached) return cached;
  const layered: Record<string, string> = {};
  const sources: string[] = [];
  for (const path of ENV_CANDIDATES) {
    const parsed = parseDotenv(path);
    if (Object.keys(parsed).length > 0) sources.push(path);
    for (const [k, v] of Object.entries(parsed)) {
      if (layered[k] === undefined) layered[k] = v;
    }
  }
  // process.env wins over files when non-empty.
  const pick = (k: string): string | undefined => {
    const fromProc = process.env[k];
    if (fromProc !== undefined && fromProc.trim() !== "") return fromProc.trim();
    const fromFile = layered[k];
    if (fromFile !== undefined && fromFile.trim() !== "") return fromFile.trim();
    return undefined;
  };

  cached = {
    apiKey: pick("ANTHROPIC_API_KEY"),
    authToken: pick("ANTHROPIC_AUTH_TOKEN"),
    baseUrl: pick("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com",
    model: pick("CLOUD_DEMO_MODEL") ?? DEFAULT_MODEL,
    source: sources.length > 0 ? sources.join(", ") : "(none)",
  };
  return cached;
}

/** True when at least one usable Anthropic credential is present. */
export function hasLiveCredentials(): boolean {
  const c = discoverCredentials();
  return Boolean(c.apiKey || c.authToken);
}

/**
 * Single-turn model call against the Anthropic Messages API. Returns real token
 * usage from the response. Never throws — failures come back as { ok: false }.
 */
export async function callModel(opts: {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
}): Promise<ModelResult> {
  const cred = discoverCredentials();
  if (!cred.apiKey && !cred.authToken) {
    return { ok: false, reason: "no ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN found" };
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (cred.apiKey) {
    headers["x-api-key"] = cred.apiKey;
  } else if (cred.authToken) {
    headers["authorization"] = `Bearer ${cred.authToken}`;
    headers["anthropic-beta"] = "oauth-2025-04-20";
  }

  const body = {
    model: cred.model,
    max_tokens: opts.maxTokens ?? 512,
    system: opts.system,
    messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  };

  const startedAt = Date.now();
  try {
    const resp = await fetch(`${cred.baseUrl}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const latencyMs = Date.now() - startedAt;
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      return { ok: false, reason: `HTTP ${resp.status}: ${detail.slice(0, 200)}` };
    }
    const json = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    return {
      ok: true,
      text,
      usage: {
        input: json.usage?.input_tokens ?? 0,
        output: json.usage?.output_tokens ?? 0,
      },
      model: cred.model,
      latencyMs,
    };
  } catch (err) {
    return { ok: false, reason: `fetch failed: ${(err as Error).message}` };
  }
}
