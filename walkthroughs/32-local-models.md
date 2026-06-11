# Recipe 32 — Local Models

Run any spec against a local OpenAI-compatible endpoint — Ollama,
vLLM, llama.cpp server, LM Studio, LiteLLM proxy — by changing one
line of YAML. The model id grammar (`local/<model>@<url>`, or bare
`local/<model>` for the Ollama default) bakes the URL into the spec;
no provider switch elsewhere.

You'd reach for local models when:

- You're **air-gapped** or operating under data-residency constraints.
- You want to **avoid API costs** for high-volume cheap workloads
  (extraction, classification, routing).
- You're **iterating on prompts** and the round-trip latency of a
  hosted provider is the bottleneck.

For production user-facing agents, hosted providers usually win on
quality and consistency.

## Prerequisites

- A locally running OpenAI-compatible server:
  - **Ollama** — `ollama serve` (default port 11434; the OpenAI shim
    lives under `/v1`).
  - **vLLM** — `vllm serve <model>` (default port 8000).
  - **llama.cpp** — `llama-server -m <gguf>` (default port 8080).
  - **LM Studio** — `lms server start` or Developer → Start Server in
    the app (default port 1234; OpenAI-compatible routes under `/v1`).
  - **LiteLLM** — `litellm --model <provider>/<model>` proxies any
    provider behind an OpenAI-compatible endpoint.

## The model id grammar

```
local/<model>@<base-url>
local/<model>
```

`<model>` is the model name the local server expects. `<base-url>`
is the OpenAI-compatible base, **including** the `/v1` segment.
Omitting `@<base-url>` is shorthand for the Ollama default
(`http://localhost:11434/v1`).

Examples:

```yaml
model: local/llama3.2                          # Ollama default endpoint
model: local/llama3.2@http://localhost:11434/v1
model: local/qwen2.5-coder@http://localhost:8080/v1
model: local/qwen2.5-7b-instruct@http://localhost:1234/v1
model: local/meta-llama/Meta-Llama-3-8B-Instruct@http://localhost:8000/v1
model: local/llama3.2@http://gpu-host.lan:11434/v1
```

The URL is parsed once at runtime — no DNS lookups per turn.

## How the router parses it

```
parseModelString("local/llama3.2@http://localhost:11434/v1")
  → { providerId: "openai", modelId: "llama3.2", baseUrl: "http://localhost:11434/v1", localUrl: true }
```

The router routes `local/*` through the OpenAI adapter with the
**baseUrl overridden in-flight**. So a spec using `local/llama3.2`
goes through the same code paths as `openai/gpt-4o` — only the
endpoint URL (and the key policy below) differs.

## No API key needed

When no key applies, the adapter sends the placeholder string
`"local"` as the bearer token — local servers (Ollama, vLLM,
llama.cpp, LM Studio) accept any non-empty value. The exact policy:

| Model string                          | Key sent                                                       |
| ------------------------------------- | -------------------------------------------------------------- |
| `local/...` at a **loopback** URL     | `OPENAI_API_KEY` if set (LiteLLM-on-localhost compat), else `"local"`. |
| `local/...` at a **non-loopback** URL | `CREWHAUS_LOCAL_API_KEY` if set, else `"local"`. Never `OPENAI_API_KEY` — a spec-supplied URL must not be able to exfiltrate your OpenAI key. |
| plain `openai/...`                    | `OPENAI_API_KEY`; throws `ProviderAuthError` when it's unset **and** no `OPENAI_BASE_URL` is configured. |

To be explicit:

```bash
OPENAI_API_KEY="" bun run run starters/cli   # works for local/ model strings
```

If your local server *does* require a key (LiteLLM proxy in front of
an upstream that wants auth), set `OPENAI_API_KEY` (loopback) or
`CREWHAUS_LOCAL_API_KEY` (remote host like `gpu-host.lan`).

## Worked examples

### Ollama

```bash
ollama pull llama3.2
ollama serve &
```

```yaml
agent:
  model: local/llama3.2@http://localhost:11434/v1
```

Llama 3.2 supports OpenAI-compatible function calling reasonably well
for short tool sequences. Long sequences or complex schemas may degrade.

### vLLM

```bash
vllm serve meta-llama/Meta-Llama-3-8B-Instruct \
  --host 0.0.0.0 --port 8000
```

```yaml
agent:
  model: local/meta-llama/Meta-Llama-3-8B-Instruct@http://localhost:8000/v1
```

vLLM is the fastest local option for production-grade throughput.
GPU-required.

### llama.cpp

```bash
llama-server -m ./models/qwen2.5-coder-7b-instruct.Q4_K_M.gguf \
  --port 8080 --host 0.0.0.0
```

```yaml
agent:
  model: local/qwen2.5-coder@http://localhost:8080/v1
```

llama.cpp is the right pick for CPU-only deployments and low-spec
laptops. Tool-use support varies by model and quantization — test.

### LM Studio

```bash
lms server start        # or: LM Studio app → Developer → Start Server
```

```yaml
agent:
  model: local/qwen2.5-7b-instruct@http://localhost:1234/v1
```

LM Studio serves whatever model is loaded in the app on port 1234,
OpenAI-compatible under `/v1`. The GUI model browser makes it the
lowest-friction way to try a new GGUF before scripting it with
Ollama or llama.cpp.

### LiteLLM proxy

```bash
litellm --config litellm-config.yaml --port 4000
```

Then any spec can route through the proxy:

```yaml
agent:
  model: local/gpt-4o@http://localhost:4000/v1
```

LiteLLM bridges to upstream providers (Anthropic, OpenAI, Bedrock,
Gemini, ...) behind one OpenAI-compatible endpoint. Useful when you
want a single observability/proxy layer in front of multiple
providers.

## Tool-use considerations

Not all local models support function calling well. Test with a
**single-turn spec first**:

```yaml
name: local-test
target: cli
agent:
  model: local/llama3.2@http://localhost:11434/v1
  instructions: |
    Call the Read tool exactly once with path="README.md" then
    respond with the first 100 characters of the result.
tools:
  - read
```

If the model can't reliably emit valid tool calls, it's not ready
for production. Workarounds:

- Use a **fine-tuned function-calling variant** (e.g. NousResearch's
  Hermes-3-Llama-3.1-8B is tuned for function calling).
- Use a **larger model**: 70B-class models reliably tool-call; 7-8B
  models are inconsistent.
- Route only **structural tasks** to local; keep tool-heavy work on
  hosted models (the workflow target makes per-step routing easy).

## Streaming behavior

Most local servers stream:

| Server     | Streaming?              |
| ---------- | ----------------------- |
| Ollama     | Yes, by default.        |
| vLLM       | Yes.                    |
| llama.cpp  | Yes.                    |
| LM Studio  | Yes.                    |
| LiteLLM    | Depends on upstream.    |

The adapter always streams; there is no spec field to disable it. One
compat shim exists: if a server 400s on OpenAI's `stream_options`
field (some older OpenAI-compatible servers do), the adapter retries
the request once without it.

## OpenAI-compatible cloud hosts

The same grammar family covers hosted OpenAI-compatible providers by
name — no URL in the spec, and each host reads **its own** key env
var (never `OPENAI_API_KEY`, so a spec can mix hosts without the keys
fighting over one variable):

```yaml
model: groq/llama-3.3-70b-versatile               # GROQ_API_KEY
model: together/meta-llama/Llama-3.3-70B-Instruct-Turbo  # TOGETHER_API_KEY
model: fireworks/llama-v3p3-70b-instruct          # FIREWORKS_API_KEY
model: openrouter/meta-llama/llama-3.3-70b-instruct      # OPENROUTER_API_KEY
model: deepseek/deepseek-chat                     # DEEPSEEK_API_KEY
model: xai/grok-3-mini                            # XAI_API_KEY
model: mistral/mistral-large-latest               # MISTRAL_API_KEY
model: cerebras/llama-3.3-70b                     # CEREBRAS_API_KEY
```

All of them ride the same OpenAI adapter as `local/*` — they're the
"my GPU is in someone else's datacenter" version of this recipe. And
remember the shorthand at the other end of the spectrum:
`local/<model>` with no URL defaults to Ollama on
`http://localhost:11434/v1`.

## Adapter caching

The model-router caches **one adapter instance per `(provider,
baseUrl, key-env)` key**. So a spec using:

```yaml
roles:
  researcher:
    model: claude-sonnet-4-6
  extractor:
    model: local/llama3.2@http://localhost:11434/v1
  judge:
    model: local/llama3.2@http://localhost:11434/v1
```

Imports the Anthropic adapter once and the OpenAI adapter once. The
extractor and judge share the same OpenAI adapter (same baseUrl);
the researcher uses the Anthropic adapter. No duplicate adapter
allocations.

## Cost tracking

The pricing table lives in
[`packages/cost-tracker`](https://github.com/crewhaus/factory/blob/main/packages/cost-tracker)
(`DEFAULT_PRICING`, keyed by provider + model-id prefix). A local
model id like `llama3.2` matches no row, so every response is a
**pricing miss**: the tracker charges $0, emits no `cost_accrual`
event, and increments its `pricingMisses()` counter. Local inference
isn't "priced at zero" — it's *unpriced*, and the miss counter is how
you notice.

To track electricity / GPU rental against a local model, pass a
pricing override at construction time (`local/*` responses report
under the `openai` provider, keyed by the bare model id):

```typescript
import { DEFAULT_PRICING, createCostTracker } from "@crewhaus/cost-tracker";

const tracker = createCostTracker(bus, {
  pricing: {
    version: "local-2026-06",
    providers: {
      ...DEFAULT_PRICING.providers,
      openai: {
        ...DEFAULT_PRICING.providers.openai,
        "llama3.2": { inputPer1M: 0.1, outputPer1M: 0.2 }, // imputed USD cost
      },
    },
  },
});
```

The cost-tracker ([Recipe 19](19-rate-limiting-and-budgets.md)) then
attributes spend to local models like it would for hosted ones.

## Latency profile

| Setup                                 | First-token latency  | Tokens/s                 |
| ------------------------------------- | -------------------- | ------------------------ |
| Ollama, llama3.2 8B, M2 Pro            | ~300ms               | 30-60                    |
| vLLM, 8B model, A10G                   | ~50ms                | 100-200                  |
| llama.cpp, 7B Q4, M1 Air                | ~500ms               | 8-15                     |
| Hosted Anthropic (for reference)        | ~250ms (first byte)   | 50-100                   |

For latency-sensitive workloads, **vLLM on dedicated GPU** beats
hosted; for cost-sensitive workloads, local is "free" but you pay
for the hardware.

## Things that look like local-model work but aren't

| Symptom                                                              | Better tool                                       |
| -------------------------------------------------------------------- | ------------------------------------------------- |
| Want to **embed** locally (for RAG).                                  | `embedderModel: local/...@...` in pipeline spec.   |
| Want a **smaller hosted** model (cheap but still hosted).             | `claude-haiku-4-5-20251001` or `openai/gpt-4o-mini`. |
| Want to **fine-tune** a model on your data.                           | Fine-tune the model server-side; route via local/.  |
| Want **offline** (truly air-gapped).                                  | Build the agent as a single binary ([Recipe 24](24-docker-and-helm.md)) + bundle the local model server. |

## What to read next

- **Mixed local + hosted with breaker fallback.** [Recipe 18 — Multi-Provider Fallback](18-multi-provider-fallback.md).
- **Prompt caching across providers.** [Recipe 33 — Prompt Caching](33-prompt-caching.md).
- **Local embedders for RAG.** [Recipe 06 — RAG Pipeline](06-rag-pipeline.md).

## Pointers to source

- **Model router:** [`packages/model-router`](https://github.com/crewhaus/factory/blob/main/packages/model-router).
- **OpenAI-compatible adapter (used for local):** [`packages/adapter-openai`](https://github.com/crewhaus/factory/blob/main/packages/adapter-openai).
- **Cost tracker (pricing table + misses):** [`packages/cost-tracker`](https://github.com/crewhaus/factory/blob/main/packages/cost-tracker).
- **Module catalog reference:** §17 in [MODULE-CATALOG.md](https://github.com/crewhaus/docs/blob/main/MODULE-CATALOG.md).
