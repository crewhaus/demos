# hello-eval

The smallest possible end-to-end demonstration of the `target: eval`
shape: a math agent, a labelled dev split, an `exact_match` grader.

## Run it

This starter is self-contained — its dataset is vendored into
`./.crewhaus/datasets/hello-eval/`, so it works from inside this
directory (or copied anywhere). Run it from here:

```bash
cd starters/eval        # if you copied it elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist   # emits the eval bundle
ANTHROPIC_AUTH_TOKEN=... bun dist/agent.ts     # scores the dev split
```

The compiled `target: eval` bundle drives the real `runEval`, so it
needs model credentials to score samples — without them every sample
fails and the run reports `passRate: 0`.

For a credential-free, deterministic proof of the eval stack, run the
section-29 smoke from the demos repo root (it exercises the dataset
registry, grader registry, regression runner, and prompt optimizer
against in-process fixtures — five probes pass in <2 seconds):

```bash
bun run smoke:section-29
```

## Structure of this demo

The files in this directory mirror exactly what recipe 12 documents:

| File                                          | Purpose                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| `crewhaus.yaml`                               | Spec: agent + dataset reference + graders + concurrency. |
| `agent.cli.yaml`                              | `target: cli` companion spec — the same math agent, runnable directly. |
| `graders.yaml`                                | Standalone graders config (used by the CLI `eval` subcommand). |
| `.crewhaus/datasets/hello-eval/v1.json`  | Dataset with train/dev/test splits (math QA). Vendored in so the harness is self-contained. |
| `.crewhaus/datasets/hello-eval/dev.jsonl` | Flat dev-split dataset that `crewhaus eval --dataset` accepts. |

To author a real eval against your own agent: copy this directory,
swap `agent.instructions`, swap the dataset, and add graders. The
dataset file shape is what `@crewhaus/dataset-registry` reads;
`graders.yaml` is what `@crewhaus/eval-grader.parseGradersConfig`
reads.

## CLI eval subcommand

The `agent.cli.yaml` companion spec is the same math agent as a
`target: cli` shape, runnable through the `crewhaus eval` subcommand
against the vendored dataset and graders (run from this directory):

```bash
bunx crewhaus eval agent.cli.yaml \
  --dataset .crewhaus/datasets/hello-eval/dev.jsonl \
  --graders graders.yaml
```

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout
and loads `demos/.env`):

```bash
bun run compile starters/eval     # emits starters/eval/dist/agent.ts
```
</details>

## What this proves

This example is the eval-stack counterpart to `hello-optimize`: the
smallest concrete shape that the eval runner reads a registered
dataset, runs an agent against it, applies the grader registry, and
produces an HTML report.

See [walkthrough 12 — Eval Harness](https://github.com/crewhaus/demos/blob/main/walkthroughs/12-eval-harness.md)
for the full walkthrough,
[walkthrough 34 — Building Custom Graders](https://github.com/crewhaus/demos/blob/main/walkthroughs/34-building-custom-graders.md)
for custom graders, and
[walkthrough 42 — Active Optimization](https://github.com/crewhaus/demos/blob/main/walkthroughs/42-active-optimization.md)
for the prompt-optimizer loop that runs on top of this stack.
