# Recipe 71 — Building agent loops visually in the Studio

**Surface:** the Studio Loop Builder — [`studio-pwa`](https://github.com/crewhaus/studio-pwa)'s `/builder` page.
**Shipped:** crewhaus 0.4.0 loop contract (the builder authors the whole 0.4 surface — `limits:` / `agent.thinking` / `hooks:` / `evaluation:` / `kind: judge` steps+nodes / `permissions.ask_mode`).

Every other recipe in this series hands you YAML. This one is the opposite door:
the Loop Builder renders a `crewhaus.yaml` **as its agent loop** and lets you
edit the spec by tapping the loop — no terminal, no clone. It's the visual
counterpart to [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md): where
Studio is the desktop web tooling, the Loop Builder is a mobile-native PWA that
compiles to a Cloudflare Worker and streams the run back onto the same loop
drawing.

The whole page is built on one idea from the agent-loops report: **every agent
is the same seven-component loop** — perceive, reason, act, evaluate, update
(memory), plus the Stop and Safety boundaries — and a spec just decides which
components are configured. The builder makes that literal: a ring (or a node
canvas) whose segments light up as you add blocks.

You'd reach for it when:

- You want to **see** what a spec's loop actually does — which components are
  wired, which are running on defaults — instead of reading it out of YAML.
- You're **authoring on an iPad** (or any browser) against your own GitHub +
  Cloudflare + Anthropic accounts, with no dev environment.
- You want to add a **judge gate** or an **approval-paused daemon** and watch
  the run pause on a real approval card before you trust it in production.

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for what a spec is.
- [Recipe 66 — Evaluation inside the serving loop](66-eval-in-loop.md) — the
  `evaluation:` block and `kind: judge` steps/nodes the builder adds visually
  are that recipe's grammar; this is the GUI for it.
- Optional, for deploy + run: a GitHub token (to save specs), and a Cloudflare
  API token + an Anthropic key (to compile-and-deploy). All are BYO and stay
  on-device — CrewHaus hosts nothing and stores none of your data.

## Opening it

The builder is hosted at **`https://studio.crewhaus.dev/builder`** (add it to
your home screen for the PWA), or run it locally from the `studio-pwa` repo:

```bash
cd studio-pwa
bun install
bunx astro dev --host   # → http://localhost:4321/builder
```

Everything except the network actions (Validate, Save, Deploy, Run) works fully
**offline** — projection and structured editing are local, so the loop keeps
drawing on a flaky connection.

## Step 1 — get a spec in

The **Spec source** panel offers three ways to seed the editor, and they all
feed the same source of truth: the `crewhaus.yaml` textarea. Every edit you make
downstream rewrites that YAML in place (comments and unknown keys survive), and
the loop re-projects as the text changes.

- **Start from a loop family.** The gallery is the report's loop taxonomy made
  executable — one seed per family: *ReAct tool loop*, *Fixed workflow*,
  *Plan → execute*, *Human-in-the-loop gate*, *Role-based crew*,
  *Manager–worker*, *Memory / episodic*, *Retrieval-augmented*,
  *Evaluator–optimizer*, *Self-reflection*, *Thinking-heavy*, *RL / trajectory*,
  *Budget-bounded daemon*, and *Approval-gated daemon*. Tap one and its working
  spec drops into the editor. Seeds that use 0.4 keys carry a `0.4.0` badge (see
  Step 4).
- **Open from GitHub.** When you've connected a token and chosen a specs repo in
  the editor, the GitHub block lists `specs/*.yaml` — open one to edit it and
  save back to the same file (the sha guard blocks a lost update).
- **Paste YAML.** Type or paste directly into the textarea.

## Step 2 — read the loop

The **Agent loop** panel projects whatever's in the editor. Which drawing you
get depends on the target:

- **Ring** — single-agent shapes (`cli`, `channel`, `managed`). The five loop
  stages are an inner band (perceive / reason / act / evaluate / update) and
  Stop / Safety are the outer boundary band. A segment is **filled** when the
  spec keys that configure it are present and **dashed** when it's running on
  defaults. Tap a segment to edit exactly those keys.
- **Canvas** — step/node/role shapes (`workflow`, `graph`, `crew`, `pipeline`,
  `research`, `batch`). Steps/nodes/roles are boxes, edges/handoffs are arrows,
  an HITL gate wears a **HITL** badge, and each box carries its own seven-segment
  mini-summary. Long-press (or right-click) a step/node/role to rename it —
  references (entry, edges, routing) follow automatically.

Anything else (voice / browser / eval / onchain, or an unknown target) falls
back to the generic ring with an honest warning rather than pretending to a
projection it doesn't have.

The `projection:` line under the drawing tells you where it came from — the
compiler-worker's `POST /loop` (once a 0.4 compiler is deployed) or the local
projection. They're field-compatible, so the loop reads the same either way.

Under the loop, **Stop conditions** collects the projection's warnings — the one
worth memorising is the defaults-only Stop warning: *"no budget: — stops only at
the 500-iteration default"*. A single-agent loop with no `budget:` or `limits:`
has exactly one boundary, and the builder says so out loud.

## Step 3 — edit blocks with schema-driven forms

Two surfaces edit the spec structurally, and both round-trip through the
comment-preserving document (your key order, comments, and unknown keys survive
every form write):

- **Blocks palette.** Per-target availability straight from the spec schema. Tap
  a block that isn't present to add it with minimal defaults; tap a configured
  block (marked ✓) to open it in the inspector.
- **Inspector.** A form for the selected loop segment, node, block, or edge —
  or the spec-level form (name / target / model / entry…) when nothing's
  selected. Each field is typed from the schema: enums render as dropdowns,
  `string-list` fields (like `tools:`) take comma- or newline-separated names
  with completion hints, numbers are integer-checked, and a required field
  refuses to be cleared (the spec would stop validating). Clearing an optional
  field deletes the key and prunes the now-empty parent map.

The **Validate** button posts to the compiler for a real schema check; the
validity badge classifies the result honestly (`valid ✓`, `N issues`, or
`remote validate unavailable` for a transport failure — never a false "invalid").

## Step 4 — add a judge gate

On a `workflow`, tap **+ Judge step**; on a `graph`, select the node you want to
gate and tap **+ Judge node**. Both insert a `kind: judge` entry — a gate that
runs no agent turn of its own, only scores the previous step's (workflow) or the
upstream node's (graph) output and, below threshold, re-runs it. On the canvas a
judge box wears a **JUDGE** badge and draws a conditional **"gates"** arrow back
at what it scores, so you can see exactly what's being graded.

The inspector's judge sub-form is [Recipe 66](66-eval-in-loop.md)'s grammar
verbatim: `criteria`, `threshold` (default 0.7), `on_fail`
(`retry_previous` / `halt` / `continue`), `max_retries`, and an optional judge
`model`. The self-reflection alternative — a top-level `evaluation:` block that
grades every turn on a `cli`/`channel`/`managed` agent — is a block in the
palette, with the same three grader kinds (`llm_judge` / `contains` / `regex`).

These 0.4 keys carry a **`0.4.0`** version tag in the palette and inspector. The
builder authors them today, but a deployed 0.3.x compiler-worker rejects them at
`/validate` as unknown keys — so the badge reads *"parses ✓ · needs compiler
0.4.0"* (blue info), **not** a red error. The moment a 0.4.0 compiler is behind
the worker, the same spec validates clean.

## Step 5 — build an approval-paused daemon

Seed the **Approval-gated daemon** family (a `channel` target). Its safety story
is `permissions.ask_mode: pause` (also editable as the **Ask mode** enum in the
permissions form): where a headless surface used to collapse an `ask`-gated tool
to a silent *deny*, `pause` instead **parks a resumable approval** and waits for
a human — a Slack Approve/Deny button, or `crewhaus approvals grant <id>` from a
terminal. Pair it with `alwaysAsk` rules on the consequential tools (Write, Bash)
and `alwaysAllow` on the read-only ones, and you have the report's HITL guardrail
carried onto a headless daemon. You'll see this pause fire for real in Step 7.

## Step 6 — deploy

The save/share/deploy row is honest about what the browser can ship:

- **Compile & Deploy** is offered only for **browser-deployable** targets —
  `cli`, `workflow`, `graph`, the shapes the PWA can compile to a Cloudflare
  Worker on your own account. It unlocks your Cloudflare + Anthropic tokens,
  compiles, uploads, and prints the `*.workers.dev` URL (then arms the run panel
  with it).
- Every other target gets the **compile-locally** badge instead of a broken
  button — a copyable `bunx crewhaus compile <name>.yaml` for your machine. (For
  the managed-PaaS path — `crewhaus deploy <fly|render|railway|heroku>` — see the
  0.4 deploy story; the builder deliberately doesn't fake it in-browser.)
- **Save to GitHub** writes `specs/<name>.yaml` back to your connected repo, and
  **Share link** copies a read-only `/view` URL (viewable only if the repo/file
  is public or the viewer brings their own token — CrewHaus stores nothing).

## Step 7 — watch the loop run live

Point **Run & watch** at a deployed worker — this session's deploy (**Use last
deploy**), a pasted `*.workers.dev` URL, or one picked **From fleet…** — send a
message, and watch the run stream back onto a read-only copy of the *same* loop:

- The ring segments / canvas nodes **pulse** as trace events arrive, so you're
  watching perceive → reason → act → evaluate → update actually cycle.
- The **HUD** ticks live: `cost` (a running `$` total), `tokens` (down/up),
  `turns`, `tools`, and `errors`.
- The **transcript** fills with the assistant's reply, and the raw **event feed**
  is there when you want the frames.
- A **pending approval surfaces as a card** with **Approve** / **Deny** buttons
  (they resolve the parked approval through the deployed gateway's runs API).
  Where the target doesn't expose that API, the card degrades to the read-only
  guidance — `crewhaus approvals grant <id>` / `crewhaus approvals deny <id>` —
  so the daemon from Step 5 is resolvable either way.

That's the whole flywheel in one page: seed a loop, edit it by tapping its
components, gate it, deploy it, and watch the deployed loop pulse — with the
approval pause you designed showing up as a card you click.

## Gotchas

| Gotcha | What's going on |
| ------ | --------------- |
| A `0.4.0`-tagged key shows "needs compiler 0.4.0", not "valid" | The builder authors 0.4 keys ahead of the deployed compiler; that badge is info, not an error. It clears once a 0.4.0 compiler is behind the worker. |
| Compile & Deploy is missing on some specs | Only `cli` / `workflow` / `graph` are browser-deployable; other targets get the copyable `bunx crewhaus compile` command instead. |
| A judge step can't be the first step | It gates the *previous* output, so there must be one — the canvas warns, and the compiler rejects it. Same for a graph *source* node as a judge. |
| The loop keeps drawing during a parse error | Projection reads the last-good parsed model, so a mid-edit typo shows the last valid loop with a "parse error — showing the last valid loop" note; structured edits pause until you fix it. |
| Approve/Deny buttons vs. the CLI guidance | The card shows buttons only when the target exposes the gateway runs API; otherwise it shows the read-only `crewhaus approvals grant <id>` command. |

## When to NOT reach for this

- **For bulk or scripted authoring.** The builder is one spec at a time by hand;
  for fleets and automation, use the CLI and IDE plugins
  ([Recipe 25](25-vscode-and-jetbrains.md)).
- **As your compiler of record.** In-browser deploy compiles `cli`/`workflow`/
  `graph` only; anything else compiles on your machine. The builder is honest
  about that rather than pretending.
- **To validate 0.4 keys against a 0.3.x compiler.** It'll parse but badge
  "needs compiler 0.4.0" — that's expected, not a bug to chase.

## What to read next

- **The eval grammar you're wiring visually.** [Recipe 66 — Evaluation inside the serving loop](66-eval-in-loop.md).
- **The desktop Studio surfaces.** [Recipe 35 — Studio Walkthrough](35-studio-walkthrough.md).
- **The HITL gate the approval daemon generalizes.** [Recipe 53 — Justification gates](53-justification-gates.md).

## Pointers to source

- **The page (all DOM + rendering):** [`studio-pwa/src/pages/builder.astro`](https://github.com/crewhaus/studio-pwa/blob/main/src/pages/builder.astro).
- **Loop projection (ring / canvas, the seven segments):** [`studio-pwa/src/lib/loop-model.ts`](https://github.com/crewhaus/studio-pwa/blob/main/src/lib/loop-model.ts).
- **Schema-driven inspector forms + structural edits:** [`studio-pwa/src/lib/form-model.ts`](https://github.com/crewhaus/studio-pwa/blob/main/src/lib/form-model.ts).
- **The loop-family gallery seeds:** [`studio-pwa/src/lib/gallery.ts`](https://github.com/crewhaus/studio-pwa/blob/main/src/lib/gallery.ts).
- **Spec grammar the forms are ground-truthed against:** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts).
- **Headless approvals (`ask_mode: pause`, `crewhaus approvals`):** [`apps/cli/src/approvals-cli.ts`](https://github.com/crewhaus/factory/blob/main/apps/cli/src/approvals-cli.ts).
