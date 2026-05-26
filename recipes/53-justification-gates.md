# Recipe 53 — Justification gates (Pillar 3 intent verification)

`permission-engine` answers **"is X allowed?"** A spec lists tools, rules attach allow/deny/ask policies, the engine evaluates per call. That's necessary but not sufficient when the failure mode is *intent drift* — the agent has the right permission but the wrong reason. SACR's [Runtime Security for AI Agents](https://softwareanalyst.substack.com/p/runtime-security-for-ai-agents) calls this the third layer: *non-deterministic governance*, evaluating not just authorization but the rationale at the moment of the request.

Cyata's "guardian agent" model and Apono's intent-based authorization both ship this as a runtime check. CrewHaus's version is the **justification gate**: opt-in per tool, defers to a configurable judge (rule-based by default, LLM-backed in production).

## What this recipe covers

- The `requireJustification: true` flag on tool descriptors
- The agent's experience when calling a justification-gated tool
- Swapping the default rule-based judge for an LLM-backed one
- Defense-in-depth interaction with the egress fabric (recipe 55)

## Prerequisites

- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md)
  for the static permission engine this layer sits on top of.
- [Recipe 41 — Security Fabric](41-security-fabric.md) for the
  source-side classifier — this recipe is one of the three Pillar 3
  defense-in-depth layers (41 source, 55 sink, 53 intent).
- [Recipe 55 — Egress Fabric](55-egress-fabric.md) for the sink-side
  fabric this gate composes with.

## Try it

No standalone justification-gate demo ships yet. The package tests at
[`factory/packages/justification-gate`](https://github.com/crewhaus/factory/blob/main/packages/justification-gate)
exercise both the rule-based and LLM-backed judges with full
sample inputs. To see a gate fire in your own spec, set
`requireJustification: true` on any tool descriptor in a `hello-*`
demo (e.g. the `Bash` tool in
[`hello-procode/crewhaus.yaml`](../hello-procode/crewhaus.yaml)) and
run the demo — the next tool call will prompt the model for a
justification field. A dedicated hello-justification demo is on the
follow-up list.

## The flow

```
                    ┌─────────────────────────────────────┐
                    │ Agent decides to call tool X        │
                    │ X.requireJustification === true     │
                    └──────────────────┬──────────────────┘
                                       │
                                       ▼
                   ┌─────────────────────────────────────┐
                   │ Model includes `justification` field│
                   │ in the tool's input alongside its   │
                   │ declared schema                     │
                   └──────────────────┬──────────────────┘
                                      │
                                      ▼
                  ┌─────────────────────────────────────┐
                  │ evaluateJustification({              │
                  │   toolName, justification,          │
                  │   sessionGoal: spec.instructions,   │
                  │   input,                            │
                  │ }, judge)                           │
                  └──────────────────┬──────────────────┘
                                     │
                  ┌──────────────────┴──────────────────┐
                  ▼                                     ▼
        ┌──────────────┐                       ┌─────────────────┐
        │ allow: true  │                       │ allow: false    │
        │ → proceed    │                       │ → deny with     │
        │ → audit-log  │                       │   verdict.reason│
        └──────────────┘                       │ → audit-log     │
                                                └─────────────────┘
```

The session goal is the spec's `instructions` field — fixed at compile time. This is deliberate: an attacker who controls runtime input (a prompt-injected email body, a malicious sub-agent return) **cannot** also re-define the goal under which their justification is scored.

## Default behavior — `requireJustification: false`

Every tool defaults to `requireJustification: false`. No change to the agent's tool-calling surface; permission-engine + egress fabric still apply.

## Opting in per tool

```yaml
# spec.yaml
tools:
  - name: SendMessage
    requireJustification: true   # default in v0.3+; opt-in for now
  - name: EvmSendTransaction
    requireJustification: true
  - name: WebSearch
    requireJustification: false  # read-only, no need
```

Recommended *default-on* set:

- `SendMessage` (channel adapter outbound)
- `EvmSendTransaction` (ledger writes)
- `ImageGenerate` (uploads + cost)
- `Federation*` outbound tools
- Any custom tool with destructive or irreversible side effects

Read-only tools (`tool-retrieve`, `tool-fs.Read`, `Grep`, `Glob`, `CodeGraphSearch`) should stay false — they're query-shaped, not action-shaped.

## What the agent sees

When `requireJustification: true`, `runtime-core` extends the tool's JSON Schema dynamically with a `justification: string` field. The model is prompted to fill it. In practice:

```json
{
  "tool": "SendMessage",
  "input": {
    "channel": "slack:T123:C456",
    "text": "Hi! Confirming we received your support ticket.",
    "justification": "user asked me to acknowledge their ticket; this is the canonical confirmation message per the spec's instructions."
  }
}
```

## The default judge (rule-based)

`ruleBasedJustificationJudge` is the default in `permission-engine`. Deterministic, no model call. Three checks:

1. **Length floor**: justification < 16 chars → deny.
2. **Empty goal**: no spec instructions supplied → allow with confidence 0 (audit only).
3. **Token overlap**: justification shares ≥1 non-stopword token with the session goal.

Suitable for tests and low-stakes deployments. It catches the egregious failures (empty justification, gibberish justification, off-topic justification) and lets reasonable text through.

## LLM-backed judge for production

Pass `justificationJudge` to `runChatLoop`:

```typescript
import { runChatLoop } from "@crewhaus/runtime-core";
import { resolveModel } from "@crewhaus/model-router";
import type { JustificationJudge } from "@crewhaus/permission-engine";

const judgeModel = resolveModel("claude-haiku-4-5");

const justificationJudge: JustificationJudge = async (input) => {
  const reply = await judgeModel.stream({
    model: "claude-haiku-4-5",
    system: [{
      type: "text",
      text:
        "You are a security judge. Decide whether the agent's stated " +
        "justification for a tool call is consistent with the session's " +
        "declared goal. Respond with JSON: { allow: boolean, reason: string }.",
    }],
    messages: [{
      role: "user",
      content:
        `Session goal:\n${input.sessionGoal}\n\n` +
        `Tool: ${input.toolName}\n` +
        `Justification: ${input.justification}\n\n` +
        `Tool input: ${JSON.stringify(input.input)}`,
    }],
    maxTokens: 256,
  });
  // ... parse JSON ...
  return { allow, reason, confidence: 0.9, judgeModel: "claude-haiku-4-5" };
};

await runChatLoop({
  // ... rest of opts ...
  justificationJudge,
});
```

The judge model should be cheaper than the agent's primary model — `claude-haiku-4-5` is the canonical choice. The TDS evaluation harness paper warns against using the *same* model family for both generation and judging (inflated scores); the rule applies here too.

## Audit trail

Every call to a `requireJustification: true` tool emits a `permission_decision` trace event with the justification, the verdict, the reason, and the judge identifier. The `audit-log` records:

```json
{
  "kind": "permission_justification_evaluated",
  "payload": {
    "toolName": "SendMessage",
    "justification": "user asked me to acknowledge their ticket...",
    "verdict": "allow",
    "reason": "2 token(s) overlap between justification and session goal",
    "judgeModel": "rule-based",
    "confidence": 0.67
  }
}
```

Verbatim — the justification IS the audit artifact; redacting it would defeat the purpose.

## Defense in depth

Recipe 55 (egress fabric) and this recipe are independent. A tool can satisfy the justification gate and STILL get blocked by the egress fabric (because its input contains tagged cross-origin content). And vice versa.

Example: agent calls `Fetch({ url: "https://safe.example.com/", justification: "fetching documentation per session goal" })`. Justification passes. But the URL contains a tagged sub-agent string. Egress classifier denies. Both events land in audit.

## Tuning

`spec-patch`'s `OPTIMIZABLE_PATHS` includes `["security", "justification"]`. `crewhaus optimize` can find the per-tool justification policy that maximizes the [12-metric rubric](12-eval-harness.md) score on your eval set (typically by relaxing justification on read-only tools and tightening on destructive ones).

## Implementation pointers

- Tool field: `RegisteredTool.requireJustification` in [packages/tool-catalog/src/index.ts](../../factory/packages/tool-catalog/src/index.ts)
- Judge interface: `JustificationJudge` in [packages/permission-engine/src/index.ts](../../factory/packages/permission-engine/src/index.ts)
- Default judge: `ruleBasedJustificationJudge` in the same file
- Runtime hook: [packages/runtime-core/src/index.ts](../../factory/packages/runtime-core/src/index.ts) (search for `requireJustification`)
- `RunChatLoopOptions.justificationJudge` to override per run

## Further reading

- SACR, "Runtime Security for AI Agents" (2026) — the three-layer model and intent-based authorization
- Cyata's "guardian agent" approach in the SACR vendor breakdown
- [recipe 41-security-fabric.md](41-security-fabric.md) — source-side fabric
- [recipe 55-egress-fabric.md](55-egress-fabric.md) — sink-side fabric (defense-in-depth pair)
- [recipe 29-permissions-deep-dive.md](29-permissions-deep-dive.md) — the static permission engine
