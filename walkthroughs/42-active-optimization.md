# Recipe 42 — Active eval optimization (Pillar 2)

**Pillar:** Pillar 2 — eval is active, not passive.
**Catalog modules:** `prompt-optimizer` (114), `prompt-optimizer-claude` (280), `spec-patch` (278), `eval-optimizer-orchestrator` (279), `eval-runner` (109), `dataset-registry` (110), `grader-registry` (111).
**Build-roadmap sections:** §16 (measurement), §29 (eval depth), §46 (active IR-patch optimizer — the section this recipe is the user-facing companion of).

## What this recipe shows

The original §29 shipped `prompt-optimizer` as a search function and `eval-runner` as a measurement function, but **nothing connected them** to the user-facing workflow. There was no `crewhaus optimize` command. The optimizer's output never became a spec patch. The eval reports never closed the loop. This recipe walks the user-facing workflow that does close the loop.

The contract is:

1. **You provide:** a spec, a dataset, a graders config.
2. **`crewhaus optimize` produces:** a `SpecPatch` (and optionally a rewritten YAML) that improved grader pass-rate, plus a report showing the score delta.

The patch is the artifact. It can be reviewed, committed, version-controlled, and re-applied — unlike a pure prompt string, it carries enough metadata to be auditable.

## Prerequisites

- [Recipe 12 — Eval Harness](12-eval-harness.md) for the dataset +
  graders pipeline that `crewhaus optimize` uses as its fitness function.
- [Recipe 34 — Building Custom Graders](34-building-custom-graders.md)
  if your domain needs graders beyond the built-in set — the optimizer
  is only as good as the signal its graders return.

## TL;DR

```bash
crewhaus optimize starters/optimize/crewhaus.yaml \
  --dataset starters/optimize/dataset.jsonl \
  --graders starters/optimize/graders.yaml \
  --iterations 5 \
  --seed 42 \
  --write-back
```

That writes the winning candidate's prompt back into `crewhaus.yaml`, prepending a header comment with the run id and score delta.

## How the loop closes

```
spec.yaml  ──parseSpec──►  Spec  ──extractCurrentPrompt──►  basePrompt
                                                                │
                                                                ▼
                                           MutationProvider (rule-based or claude)
                                                                │
                                                                ▼
                                                    candidate prompts
                                                                │
                                                                ▼
        spec.yaml  ──applySpecPatch──►  patched YAML  ──compile──►  IR
                                                                          │
                                                                          ▼
                                                                   eval-runner
                                                                          │
                                                                          ▼
                                                                    passRate
                                                                          │
                                                                          ▼
                                                              fitness for prompt-optimizer
                                                                          │
                                                                          ▼
                                                                  next iteration
```

Each iteration patches the spec, re-compiles, re-runs eval. The orchestrator records the trajectory and emits the winning patch.

## Mutators

### Rule-based (default)

Picks one of four deterministic mutations per iteration:

- `rephrase-instruction` — appends "Be concise and direct."
- `add-few-shot` — inserts a training sample as an `Example:` block
- `swap-example` — replaces an existing few-shot with a different one
- `add-COT-prefix` — prepends "Think step by step before answering."

The seeded RNG makes the search reproducible. Use this for tests and CI gates.

### Claude (model-driven)

Calls a Claude model with the current prompt and a sample of dev-set failures, asks for a single JSON `{ rewrite, rationale }`. The mutator falls back to the current best on any failure (model outage, malformed response) so the search loop never aborts mid-run.

```bash
crewhaus optimize <spec> --mutator claude --iterations 10
```

Requires `ANTHROPIC_AUTH_TOKEN` (Claude Max OAuth) or `ANTHROPIC_API_KEY`. Cost-gated via `cost-tracker`: pass `--budget-usd N` to bound the run by a dollar ceiling (see [Bounding cost](#bounding-cost) below).

### meta-harness (EXPERIMENTAL)

A third mutator, built the same way `--mutator claude` builds its provider (the spec's own model through `@crewhaus/model-router`). **What differs is the proposer's INPUT**: instead of a fixed summary window, it reads the run's filesystem-backed **experience store** — every prior candidate's artifact, per-sample scores and trace, written under `<out>/experience/candidate_NNN/` as the run measures them. Iteration N sees every earlier measurement. It rewrites the whole prompt each iteration rather than editing it.

```bash
crewhaus optimize <spec> --mutator meta-harness --budget-usd 2.00 --iterations 10
```

Same accept gate, same `--budget-usd` meter, same `OPTIMIZABLE_PATHS` validation as the other two. **Every run prints an experimental notice**, and published results on trajectory-level scaffold search are mixed — review every accepted patch.

**It is deliberately spec-shaped.** The CLI proposer returns replacement *instructions*, so a candidate still round-trips through `parseSpec` and lands behind the same gate. The package's whole-**bundle** rewriting mode stays **library-only**: a model-authored `agent.ts` has neither the `OPTIMIZABLE_PATHS` gate nor the `parseSpec` round-trip that make an automated write-back reviewable.

### When to use which

- **Rule-based** when you want a deterministic CI gate, a fast probe of "does the prompt have obvious room to improve", or you don't have Claude credentials.
- **Claude** when the prompt is the bottleneck (failures look like instruction-following issues, not skill issues) and you can spend real model dollars.
- **meta-harness** when a long search keeps rediscovering the same dead ends and you want the proposer to see the whole history — and you're prepared to read every patch it proposes.

## Bounding cost

A model-driven run issues one Claude call per iteration, so its expense scales with `--iterations`. By default the only rail is that iteration count; spend within it is unbounded. Pass `--budget-usd <amount>` to add a **dollar ceiling**:

```bash
crewhaus optimize crewhaus.yaml --mutator claude --budget-usd 2.00 --iterations 20 --write-back
# runs until the last full iteration that fits under $2.00, then stops with the best patch so far
```

How the gate works — **estimate-before, record-after**:

1. **Before** each mutation call, the orchestrator computes a worst-case cost for the upcoming call (a `chars/4` token estimate of the model-driven provider's *full serialized input* — the system block plus the rendered dev-set failure window it will actually transmit, not just the candidate prompt — priced at the model's input rate, plus the full `maxTokens` output ceiling at the output rate) using the same versioned `cost-tracker` pricing table that meters the rest of the system. The Claude provider exposes the exact input length via an `estimateInputChars` hook; providers that don't fall back to the prompt length plus a fixed overhead margin.
2. If `spent-so-far + that estimate` would exceed `--budget-usd`, the run **stops before issuing the call** — it never spends past the budget on a call it could have skipped. It returns the best candidate found so far with `stopped: budget-reached`.
3. **After** a call completes, its *actual* token usage (from the response) is folded into the running total.

The estimate is conservative-high on **both** cost axes: the output side uses the `maxTokens` ceiling (the dominant axis), and the input side prices the full serialized meta-prompt, so a wide dev-sample window cannot let a gate-passing call exceed the budget after the fact. A call that clears the pre-call gate cannot blow the budget.

The gate **composes with `--iterations`**: whichever bound is hit first ends the run. Omit `--budget-usd` and you get exactly today's behavior (iterations cap only).

The `crewhaus optimize` command threads a trace bus into the run, so the orchestrator publishes one `cost_accrual` event per model call **plus** a terminal aggregate accrual (`summary: true`) carrying the run total — the spend lands on the standard observability bus, not only in `report.json`. The run-total `$` also prints to stdout; set `CREWHAUS_TRACE_COST=1` to echo each bus cost event to stderr:

```
[optimize] score: 0.450 → 0.780 (Δ +0.330)
[optimize] spend: $1.8600 over 3 model call(s) (stopped: budget reached, $2.00 cap)
```

> **Rule-based runs are always `$0`.** The rule-based provider makes no model calls, so it reports zero cost and ignores `--budget-usd` — passing the flag on a rule-based run is harmless and the run completes under the iterations cap. (An unmapped/brand-new model id that `cost-tracker` cannot price also degrades to iterations-cap, since an unpriceable call cannot be gated.)

## Output

Every run produces:

- `.crewhaus/optimize/<runId>/patch.json` — the structured patch (always)
- `.crewhaus/optimize/<runId>/report.json` — score delta + mutator metadata
- `.crewhaus/optimize/<runId>/trajectory.json` — every candidate prompt + score
- `.crewhaus/optimize/<runId>/best.json` — the winning candidate

With `--write-back`, the source YAML is rewritten with a leading header comment:

```yaml
# crewhaus optimize: runId opt_xxxx
# - mutator: rule-based
# - iterations: 5
# - score: 0.450 → 0.780 (Δ 0.330)
# - generated: 2026-05-10T12:00:00Z

# (the rest of your YAML, with only the touched values changed —
# comments and key order preserved by the CST round-trip)
```

## Multi-stage specs and `--stage`

`crewhaus optimize` accepts **workflow / graph / crew / pipeline** specs, not just `cli`. Each candidate is compiled with the eval-entry variant — the *same* emission `crewhaus compile --with-eval-harness` performs, not a second bespoke emitter — and measured by driving that compiled runtime per sample through the same bridge invoker `crewhaus eval` uses, behind the identical eval-gated accept loop, budget gate and post-accept regression pinning.

```bash
crewhaus optimize workflow.yaml --dataset eval/dataset.jsonl --graders eval/graders.yaml
crewhaus optimize workflow.yaml --stage draft --iterations 8   # just that step
```

- Only the per-stage prompt paths already in `OPTIMIZABLE_PATHS` are rewritten: workflow step / graph node / crew role instructions, and a pipeline's `agent.instructions`. **`kind: judge` steps and nodes run no agent turn and are never mutated** — the optimizer cannot relax the gate it's being measured by.
- **`--stage <name>`** narrows to one step/node/role. An unknown name errors and **lists the valid ones**.
- **Without `--stage`**, stages optimize **sequentially in declaration order, each gated independently**: a winning stage composes into the working spec the next stage starts from; a losing stage leaves the spec untouched and the run moves on.
- **`--iterations` is per stage**; **`--budget-usd` stays a RUN ceiling**, threaded down as remaining budget so a three-stage run cannot spend 3× the cap. The source spec is written once, at the end, and only with `--write-back`.
- **`--stage` is refused alongside `--from-advice`** (which applies pre-computed patches and runs no per-stage search).
- **Boundary the `--help` states:** the candidate bundle carries bare `@crewhaus/*` imports, so a bridged run resolves them from the candidate directory upward — **run it inside a harness whose dependencies are installed** (the default `-o` under `.crewhaus/optimize/<runId>/` already is).

There is no `--path` flag, and there never was — `OPTIMIZE_SCHEMA` never defined one. The old refusal message that pointed at it has been rewritten to name the spec's **actual stages** and `--stage`.

### What the search measures (narrower than the gate)

The fitness eval reduces each sample to `{id, input, expected_output?}`:

- Samples carrying **`history`** are **refused up front** on the bridged, non-chat-capable shapes (workflow/graph/crew) — their compiled runtimes take one trigger input.
- **`expected_tools` and `metadata` are stripped during the search**, so tool-accuracy graders and slice reporting apply at the `crewhaus eval` gate, not inside the loop. Regression pinning keeps the **original, un-stripped** records, so the gate grades them in full.

## Optimizable paths

The full `OPTIMIZABLE_PATHS` whitelist (in [`packages/spec-patch/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec-patch/src/index.ts)) covers every shipped target shape and is much broader than instructions alone — `agent.max_tokens`, `agent.thinking.budget_tokens`, `failure_taxonomy`, the compaction knobs (`threshold`, `curate`, `dedupeThreshold`, `relevanceTopK`), `limits.max_tool_iterations`, `security.justification`, `chains`, `transaction_policy`, `agent.model_pool.policy`/`routing`/`learning`, the memory quality knobs, `evaluation.threshold`/`max_retries`, the indexing/retrieve dials, and the multi-stage per-stage instruction paths above.

Adding a new field to the whitelist is the explicit signal that "this field is safe to autotune." Security-critical fields (`permissions.mode`, `model_router` rules, MCP server configs) are deliberately excluded — the optimizer can't accidentally rewrite the production safety floor.

### Numeric-knob search — library-only

`@crewhaus/prompt-optimizer` gained a **`knob-step`** mutation: bounded coordinate-ascent steps over declared `OPTIMIZABLE_PATHS` numeric dials, alternating with instruction rewrites, every proposal gated by the same fitness accept loop. The orchestrator threads `knobs` through, validates each dial against the whitelist **before** anything is spent, and emits one whitelist-validated `SpecPatch` per moved dial (`patches.json` beside `patch.json`).

> **State the boundary honestly: there is NO `--knobs` CLI flag.** The dial set is reachable programmatically (`optimizeSpec({ knobs })`) only. Nothing in the CLI builds one, so a `crewhaus optimize` or `crewhaus flywheel run` today proposes **no knob changes** — the flywheel's own `--help` says exactly that. Declaring no knobs leaves the search prompt-only and byte-identical.

### The few-shot leak guard

`--few-shot <pool|auto>` injects the top-K harvested examples into the candidate instructions. Injection now runs **after** the dataset is materialized and drops every pool example whose `(sessionId, turnNumber)` provenance appears in the eval dataset's `metadata.sessionId` / `metadata.turnNumber` stamps:

```
[optimize] few-shot: excluded 3 pool turn(s) overlapping the eval dataset
```

Counted, logged, never silent. A pool with no provenance metadata excludes nothing — and if **every** pool example overlaps, the run **refuses** rather than injecting nothing and pretending the flag applied.

### Inline ratings redact by default

`--ratings <session>|all` distills feedback inline for the run. Sample text is now PII/secret-redacted **by default** before it reaches the sample pool, the synthesized graders, or the optimizer meta-prompt — the same detector set as `crewhaus distill`. `--no-redact` keeps it raw (dev/local only).

## What `--write-back` actually does

The biggest reason developers refuse to run `--write-back` against a committed spec is fear: "is the optimizer going to strip my comments? reorder my keys? clobber the `# DO NOT CHANGE THIS PROMPT` warning my teammate left?" The answer is no, but the mechanism is worth showing concretely so you trust the answer. (For a side-by-side walkthrough that includes the failing-eval trace events alongside the YAML before/after, see [GETTING-STARTED.md § Scenario 2 — an eval failed and the optimizer wants to patch your prompt](https://github.com/crewhaus/docs/blob/main/GETTING-STARTED.md#scenario-2--an-eval-failed-and-the-optimizer-wants-to-patch-your-prompt).)

`applySpecPatch` ([packages/spec-patch/src/index.ts:90](https://github.com/crewhaus/factory/blob/main/packages/spec-patch/src/index.ts)) parses the YAML to a **concrete syntax tree** via the [`yaml`](https://eemeli.org/yaml/) package's `parseDocument`, mutates the targeted node by spec-path, and renders the tree back with `Document.toString()`. The CST tracks every byte of whitespace, every comment (leading, trailing, mid-line), and every key order. Bytes the patch doesn't touch render verbatim.

### Worked before/after

Starting spec:

```yaml
# crewhaus.yaml — coding agent for our team
# Owner: @max. Reviewed 2026-04-30.
name: my-coding-agent
target: cli

agent:
  model: claude-sonnet-5
  # DO NOT CHANGE THIS PROMPT WITHOUT TEAM REVIEW (incident 2026-03-04)
  instructions: |
    You help with TypeScript. Read files before editing.
tools:
  - read
  - edit
  - bash
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAsk,   pattern: Bash(**) }
```

After `crewhaus optimize ... --write-back` with a rule-based mutator picking `add-COT-prefix`:

```yaml
# crewhaus optimize: runId opt_a8f3b21c
# - mutator: rule-based
# - iterations: 5
# - score: 0.450 → 0.780 (Δ 0.330)
# - generated: 2026-05-12T17:42:00Z

# crewhaus.yaml — coding agent for our team
# Owner: @max. Reviewed 2026-04-30.
name: my-coding-agent
target: cli

agent:
  model: claude-sonnet-5
  # DO NOT CHANGE THIS PROMPT WITHOUT TEAM REVIEW (incident 2026-03-04)
  instructions: |
    Think step by step before answering.

    You help with TypeScript. Read files before editing.
tools:
  - read
  - edit
  - bash
permissions:
  mode: default
  rules:
    - { type: alwaysAllow, pattern: Read }
    - { type: alwaysAsk,   pattern: Bash(**) }
```

Things to notice line by line:

- The header comment on `agent.instructions` — the `# DO NOT CHANGE THIS PROMPT…` line — is **untouched**. The patch path was `["agent", "instructions"]`; the comment is attached to the parent `agent` mapping's `instructions` key, and `Document.setIn` replaces the *value* without disturbing the surrounding comment metadata.
- The two top-of-file comments (`# crewhaus.yaml — coding agent…` and `# Owner: @max…`) are preserved verbatim and still precede the spec body.
- The blank line between `target: cli` and `agent:` is preserved — the CST tracks it as the trailing trivia of the `target` key.
- The `permissions` block is byte-identical. It was not in the patch path and therefore was not even visited.
- The new run-header comment (`# crewhaus optimize: …`) is prepended above everything via `formatWriteBackHeader`, so the audit trail of "this file was rewritten by an optimization run" is the first thing a reviewer sees in `git diff`.
- `tools:` is rendered as a block sequence in both files — the CST preserves the user's choice of block-vs-flow style. A spec written with `tools: [read, edit, bash]` would render back the same way.

### What happens if the optimizer targets a structurally volatile field

The critique scenario is: "two `alwaysAllow` rules in my YAML were deduped by the compiler. The optimizer wants to tighten one. Does it append a third rule? Overwrite the survivor? Silently fail?"

The answer is **none of those — the orchestrator refuses the patch at validation time, before it ever reaches the CST**. The `OPTIMIZABLE_PATHS` whitelist (above) excludes `permissions.rules`, `permissions.mode`, `mcp_servers.*`, and every other path whose lowering is not field-preserving (re-ordering, deduping, env-rewriting). `validatePatch` ([packages/spec-patch/src/index.ts:157](https://github.com/crewhaus/factory/blob/main/packages/spec-patch/src/index.ts)) throws a `SpecPatchError` with the path that the optimizer attempted and a pointer back to the whitelist:

```
SpecPatchError: path permissions.rules.2 is not listed in
OPTIMIZABLE_PATHS for target "cli"; add it to
packages/spec-patch/src/index.ts if it's intended to be tunable
```

For every whitelisted path, the lowering is a 1:1 field copy from spec to IR. No dedup, no reorder, no rewrite. The patch path, the spec path, and the CST path are the same path. The "lossy lower" question doesn't apply at this layer; it's gated upstream. That is exactly the property a path must have to *earn* a place on the whitelist.

If you want to extend the autotuning surface to a field that currently *is* lossy-lowered (e.g. `permissions.rules` after a "merge equivalent rules" pass), the contract is:

1. Make the lowering for that field field-preserving (or carry a position-stable id from spec to IR).
2. Add the path to `OPTIMIZABLE_PATHS`.
3. Add a test that round-trips a comment-bearing YAML through `applySpecPatch` for the new path and asserts the comments survive.

Step 1 is the work. Steps 2 and 3 are checkboxes. The single-chokepoint design only holds if every new optimisation surface goes through the same gate.

### Why this is enough (no source maps needed)

The critique reasonably asked whether the system uses a source map from the parse phase to track line numbers and node ids back to the CST. It doesn't — and doesn't need to. **Patches are addressed by spec field paths**, not by AST node ids. Those paths exist identically in the source YAML and in the parsed `Document`. The CST library handles the parse-and-render-back; the orchestrator never needs to refer to a line number to know where in the source to write.

The thing that would require a source map is patching IR-derived structure (a specific rule in a deduped, reordered `permissions.rules` array) back to the source. That is precisely the case `OPTIMIZABLE_PATHS` refuses. The whitelist *is* the design decision that says "we will not patch fields whose source-to-IR map is non-trivial." The choice is structural, not bolted-on.

See [docs/COMPILER-ARCHITECTURE.md §The lossy lower, and how `crewhaus optimize` writes back](https://github.com/crewhaus/docs/blob/main/COMPILER-ARCHITECTURE.md#the-lossy-lower-and-how-crewhaus-optimize-writes-back) for the same contract from the compiler's side.

## Comparison to DSPy

This recipe is crewhaus's answer to DSPy's MIPRO result. The differences:

- **Crewhaus mutates SPECS, not in-memory Python programs.** Patches are version-controllable; DSPy's program state typically isn't.
- **The mutation provider seam is explicit.** Rule-based, Claude-driven, and meta-harness mutators are first-class; future providers (a DSPy bridge, an OPRO implementation) can plug in via the same `MutationProvider` interface without changing the orchestrator.
- **Comments and key order survive** via the YAML CST round-trip. A developer reviewing a `--write-back` diff sees exactly what changed.
- **Multi-stage programs optimize stage by stage**, each gated independently, driving the shape's real compiled runtime through the eval bridge.

## Dataset-split hygiene

Two rules the optimizer enforces so a search can never train on its own exam:

- A bare `--dataset registry:<name>` resolves **train + dev only**; the locked `#test` split is excluded with a stderr note.
- An explicit `#test` ref is **refused outright** — flag or no flag. Only `crewhaus eval` and `crewhaus deploy canary` can consume it, behind `--allow-test-split`, and `crewhaus datasets release` is the sanctioned way to spend it. See [Recipe 12 §The test-split lock](12-eval-harness.md#the-test-split-lock-on-every-consumption-path).

A registry record with populated train **and** dev splits is used as-is; otherwise the selected samples get the inline 70/30 split.

## When to NOT use the optimizer

- **Before you have a real dataset.** The optimizer is only as good as the fitness function; a dataset with 5 samples will produce noise, not signal.
- **For security policy decisions.** The optimizer is a safety regression if it can write permission rules. `OPTIMIZABLE_PATHS` exists to prevent this.
- **As a substitute for thinking.** The Claude mutator can fix surface-level instruction-following issues, not architectural problems. If your eval is failing because your agent is missing a tool, no amount of prompt tuning will help.
- **`--mutator meta-harness` as a default.** It is experimental, it says so on every run, and the published evidence for trajectory-level scaffold search is mixed.

## What to read next

- **The eval stack this optimizes against.** [Recipe 12 — Eval Harness](12-eval-harness.md).
- **Scheduling the loop and gating it nightly.** [Recipe 56 — The self-improvement flywheel](56-self-improvement-flywheel.md).
- **Bringing a non-cli shape into the loop.** [Recipe 61 — Self-building evals](61-self-building-evals.md).
- **Tiering the gate in CI.** [Recipe 74 — Eval suites, cassettes, red teams](74-eval-suites-and-cassettes.md).

See [/CLAUDE.md §Pillar-2](https://github.com/crewhaus/factory/blob/main/CLAUDE.md) for the contributor invariants this recipe is the user-facing companion of.
