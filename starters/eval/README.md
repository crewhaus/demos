# hello-eval

The smallest possible end-to-end demonstration of the `target: eval`
shape: a math agent, a labelled dev split, an `exact_match` grader.

## Run it

The cleanest end-to-end demo of the eval stack today is the section-29
smoke. It exercises the dataset registry, grader registry, regression
runner, and prompt optimizer against in-process fixtures (no model
calls, no credentials needed):

```bash
bun run smoke:section-29
```

Five probes pass in <2 seconds. That is the proof that the eval
runtime is wired correctly.

## Structure of this demo

The files in this directory mirror exactly what recipe 12 documents:

| File                                          | Purpose                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| `crewhaus.yaml`                               | Spec: agent + dataset reference + graders + concurrency. |
| `graders.yaml`                                | Standalone graders config (used by the CLI `eval` subcommand). |
| `../.crewhaus/datasets/hello-eval/v1.json`    | Dataset with train/dev/test splits (math QA).        |

To author a real eval against your own agent: copy this directory,
swap `agent.instructions`, swap the dataset, and add graders. The
dataset file shape is what `@crewhaus/dataset-registry` reads;
`graders.yaml` is what `@crewhaus/eval-grader.parseGradersConfig`
reads.

## Compile the bundle

```bash
bun run compile eval
```

Emits `dist/agent.ts` — a single-file `target: eval` bundle that loads
the dataset registry, parses the synthesized graders config, and calls
`runEval`. The compiled bundle is the structural shape you'd deploy;
`smoke:section-29` is the proof the runtime is wired.

> Note: `bun run run eval` invokes the compiled `dist/agent.ts`
> directly. There is a current API drift in `@crewhaus/target-eval-bundle`
> against the latest `runEval` signature — the runtime walkthrough via
> `smoke:section-29` is the supported end-to-end path until that
> codegen lands.

## What this proves

This example is the eval-stack counterpart to `hello-optimize`: the
smallest concrete shape that the eval runner reads a registered
dataset, runs an agent against it, applies the grader registry, and
produces an HTML report.

See [`recipes/12-eval-harness.md`](../recipes/12-eval-harness.md) for
the full walkthrough,
[`recipes/34-building-custom-graders.md`](../recipes/34-building-custom-graders.md)
for custom graders, and
[`recipes/42-active-optimization.md`](../recipes/42-active-optimization.md)
for the prompt-optimizer loop that runs on top of this stack.
