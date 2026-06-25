# hello-workflow — workflow target vertical slice

A two-step sequential agent: step 1 lists the current directory via `bash`,
step 2 summarizes what step 1 found. Demonstrates the workflow target shape
end to end (spec → IR → codegen → runtime).

## Run it

```bash
cd starters/workflow                           # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist    # writes dist/agent.ts
ANTHROPIC_AUTH_TOKEN=sk-ant-oat... bunx crewhaus run crewhaus.yaml
```

Or run the compiled entrypoint directly:

```bash
ANTHROPIC_AUTH_TOKEN=sk-ant-oat... bun dist/agent.ts
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile workflow
bun run run workflow
```

</details>

The agent runs both steps in order and exits. Step 1's terminal assistant
text is threaded into step 2's user message as context.

## What this slice exercises

Catalog modules touched (per [`MODULE-CATALOG.md`](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md)):
- F1 `spec-schema` (workflow variant), `spec-parser`, `spec-validator`, `ir-model` (`IrWorkflowV0`)
- F2 `compiler-core` (workflow dispatch), `target-workflow`, `codegen-templates`
- F4 `spec-cli`
- R1 `runtime-orchestrator` (single-turn mode + seedMessages)
- R2 `model-adapter` (Anthropic only)
- R3/R4 `tool-catalog`, `tool-builder`, `tool-validate`, `tool-permission-matcher`, `tool-executor`, `tool-bash`

## Not yet in the slice

Parallel/conditional/branching steps, per-step structured I/O, retry/branch
logic, fan-out — see PART G build dependency order in the module catalog.
