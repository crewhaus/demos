# Demo drivers — every starter and every recipe, on camera, beat by beat

Two things in this repo ship a **`demo.beats.json`** — a manifest for the
**[Demo Driver](https://github.com/crewhaus/demo-driver)** VS Code extension:

| Root | One per | Types |
|---|---|---|
| [`starters/<path>/demo.beats.json`](./starters/) | starter | that starter's committed `crewhaus.yaml` |
| [`walkthroughs/drivers/<recipe>/demo.beats.json`](./walkthroughs/drivers/) | recipe | that recipe's own committed fenced blocks |

The manifests are plain JSON, so any comparable driver can consume them.

Click a beat (or tap **⌘⌥N**) and the driver **types** real committed bytes into
a scratch file keystroke by keystroke, **runs** real `crewhaus` commands in a
managed terminal, **opens** the datasets and reports, and **feeds** the REPL the
questions the thing being demoed is built to answer.

The point: you can record a screencast of any starter or any recipe without
rehearsing a single keystroke, and the thing on screen is what's committed here —
not a slide about it.

```bash
bun run drivers:verify              # replay every driver; assert it's green
bun run drivers:verify cli rag      # just these
bun run drivers:verify 05-stateful  # a recipe's driver
bun run drivers:verify --report r.json
```

## Drive one

1. Open **this repo** as the VS Code workspace.
2. Install the [Demo Driver](https://github.com/crewhaus/demo-driver) extension —
   clone it and run `npm install`, then package a `.vsix` with
   `npx @vscode/vsce package` and install it (*Extensions ▸ … ▸ Install from
   VSIX*), or press **F5** there for a dev host.
3. **⌘⌥⇧D** opens the beats panel. Pick a starter from the manifest dropdown —
   the driver auto-discovers all of them.
4. Put your API key in `demos/.env` (`ANTHROPIC_AUTH_TOKEN` or
   `ANTHROPIC_API_KEY`); the Setup group sources it into the demo terminal.
5. Tap **⌘⌥N** to run the next beat. That's the whole take.

Turn **off** `editor.formatOnSave` for this workspace — a formatter can reflow
the exact bytes the driver typed.

## The convention every driver follows

| Rule | Why |
|---|---|
| Lives at `starters/<path>/demo.beats.json` or `walkthroughs/drivers/<recipe>/demo.beats.json` | Paths stay short on camera; the driver sits next to what it demos. |
| `"cwd": "."` — the manifest's own directory | A starter is a self-contained harness, and a walkthrough driver dir is a scratch one: the CLI resolves the spec, local sources, MCP servers, and `.crewhaus/` store from the working directory. No beat ever `cd`s — reach further out by relative path (`. ../../../.env`), the way the Setup group already does. |
| Types into `live/crewhaus.yaml` (gitignored) | The committed `crewhaus.yaml` is never mutated by a take, so a half-finished recording leaves no diff. |
| The Setup group `reset`s the scratch file before any spec beat | Creates `live/` and blanks it, so re-takes are idempotent. (`starters/federation` has no spec, so it has no reset.) |
| Spec beats are contiguous `sourceLines` slices of a **committed** file | The bytes on screen are the real bytes — a starter's `crewhaus.yaml`, or a recipe's own fenced block. When the slices tile one whole file, `drivers:verify` asserts the typed result is byte-identical to it. A driver cannot drift from what it demos. |
| One command per `command` beat | The viewer reads one thing. |
| Every `command` / `input` beat carries a `verify` block | So the whole drive is machine-checkable (below). |
| `[needs-key]` / `[manual]` prefixes the `cue` of any non-offline beat | The operator knows, at a glance, which beats need a key or a human. |

The extension reads only its own known fields, so the `verify` block rides along
in the same file and never reaches the UI.

### Beat modes

```jsonc
"verify": { "mode": "offline", "expectedExit": 0, "note": "…", "produces": ["live/dist/agent.ts"] }
```

- **`offline`** — no API key, no platform token. `drivers:verify` **runs it** and
  asserts `expectedExit`. `produces` paths are asserted to exist afterwards.
  This is where the proof lives: `lint`, `--emit-ir`, `compile … --check`,
  deliberate non-zero rejections. An offline beat may not pipe into `head`/
  `tail`/`less` — the pipe replaces the command's exit code with the pager's, so
  the assertion would be vacuous; redirect to a file and `open` it instead. A
  beat that demonstrates a *missing* credential must scrub it explicitly
  (`env -u SLACK_BOT_TOKEN …`), since the Setup group already sourced `.env`
  into the same terminal.
- **`needs-key`** — needs live provider credentials (`crewhaus run`, `eval`,
  `optimize`, booting a daemon) or a platform token (a channel's Slack/Discord
  app). Schema- and path-checked, never executed.
- **`manual`** — needs a human: a dev server to click through, a browser
  session, a voice call.

### The shape of a driver

```
Setup                       open the README · reset live/crewhaus.yaml · source the repo's .env
                            (../../ from starters/<x>/, ../../../ from a nested starter)
Beat 1 · the spec           contiguous sourceLines slices, one per spec block
Beat 2 · compile, don't trust   lint → --emit-ir → compile -o live/dist --check
Beat 3 · run it             target-appropriate: crewhaus run + input beats, or boot the bundle
One more thing              the starter's own payoff — eval, optimize, provision, a report
```

`crewhaus compile <spec> -o live/dist --check` is the money beat: it asserts the
emitted bundle's shape, installs its `@crewhaus/*` deps, and boots it — **exit 0
with no key** whenever the only thing missing is a credential or input the spec
itself declares, which it reports as a *named gate* rather than a failure. Since
factory PR #345 that includes an unset **MCP server** env var, alongside provider
credentials and the spec's own env refs: both `starters/expert` and
`starters/trader` need `THREDZ_API_KEY`, and their `--check` beat is now GREEN /
`expectedExit: 0` with `boot gated (boot reached its MCP server credentials
gate …)`. The bundle's own boot still exits 21 on the missing variable — only
`--check`'s classification of it changed. Note `--check` scrubs the environment
(PATH/HOME/proxy/CA only, empty `--env-file`, no `--allow-env`), so exporting the
key first changes nothing: the verdict is structural, and a real credential is
proved by `crewhaus run` / a `needs-key` beat instead. `--check` is still *not*
unconditionally green — a structural break (SyntaxError, unresolved import,
anything matching no gate) stays RED and exits 1.

**One port-binding boot per suite.** `--check`'s liveness boot runs the real
daemon, and a `managed` bundle binds `:3000`. Because `--check` scrubs the
environment, `PORT=… crewhaus compile … --check` does *not* reach the boot — the
override is dropped and the daemon still takes 3000. So a second driver whose
`--check` boots a daemon will intermittently fail with `Failed to start server.
Is port 3000 in use?` when the suite runs them back to back. Exactly one driver
may prove that boot — for the managed target that is
[`drivers/11-managed-multitenant`](./walkthroughs/drivers/11-managed-multitenant/demo.beats.json).
A driver that only needs a managed harness as scaffolding (rate limits,
compliance, PII) should stop at `crewhaus compile <spec> -o live/dist`, which is
still `offline` / `expectedExit: 0`, and say in its `note` why it isn't `--check`.

Only `cli` and `browser` targets can `crewhaus run`; `eval`, `optimize`, and
`flywheel` are `cli`-only. Everything else demos by compiling and booting the
bundle (`bun live/dist/agent.ts`). A deliberate rejection — running a
compile-only shape to show the error — is a fine beat: set `expectedExit` to the
real code and say so in the cue.

## Walkthrough drivers

Every recipe under [`walkthroughs/`](./walkthroughs/) has a driver at
`walkthroughs/drivers/<recipe>/demo.beats.json`, where `<recipe>` is exactly the
recipe's filename minus `.md` (`05-stateful-graph.md` → `drivers/05-stateful-graph/`).
Same schema, same `verify` blocks, same gate — three differences:

| | Starter driver | Walkthrough driver |
|---|---|---|
| Types from | the starter's `crewhaus.yaml` | the recipe's own fenced blocks (`source: "../../<recipe>.md"`) |
| Ladder | `exact` — the slices tile the whole spec | usually `partial` — the slices are separate fences, which is not a failure |
| Its directory | ships the starter (spec, README, `.env.example`) | ships **only** the `demo.beats.json`; everything a take writes there is scratch |

A recipe's spec fences are the ones `bun run walkthroughs:test` already
compile-validates (a ```` ```yaml ```` fence with both `name:` and `target:`), so a
slice of one is a spec the repo has already proved parses. Typing the recipe's own
bytes is what keeps the two in lockstep: edit the fence, and a driver whose slice
boundaries no longer line up fails the gate.

Paths out of a driver dir: the recipe is `../../<recipe>.md`, the repo root is
`../../../`, so `../../../.env`, `../../../starters/cli/crewhaus.yaml`,
`bun ../../../smoke/section-27-smoke/smoke.ts`.

A recipe with no spec fence of its own — the concept recipes (hooks, permissions,
observability) — still gets a real driver: it types the committed starter its
*Prerequisites* section points at, then types the recipe's own concept payload
(its hooks JSON, its graders file, its permissions block) into the file the recipe
says it lives in, and proves the result offline.
[`drivers/14-hooks`](./walkthroughs/drivers/14-hooks/demo.beats.json) is the
reference for that shape;
[`drivers/01-cli-coding-agent`](./walkthroughs/drivers/01-cli-coding-agent/demo.beats.json)
is the reference for a recipe that carries its own specs.

## What `drivers:verify` proves

1. **Schema** — ids unique, actions known, required fields present, every
   command classified.
2. **Materialization** — replays `reset`/`type` with the driver's exact
   placement semantics (replace · append · `anchor`+`position` · `sourceLines` ·
   `appendNewline`).
3. **Ladder integrity** — a slice ladder must reproduce the committed spec
   byte-for-byte. Edit a starter's spec, and any driver whose slice boundaries no
   longer line up fails here.
4. **Offline commands** — executed in order, from the manifest's `cwd`, at the
   file state that beat will actually see, and in **one persistent shell per
   manifest** — the same single terminal the Demo Driver types into, so an
   `export` in one beat reaches the beats after it exactly as it will on camera.
5. **Paths** — every `open` file and `type` source resolves at that point in the
   drive.

Scratch dirs are swept afterwards (`--keep` to inspect them). `--schema-only`
skips execution. `CREWHAUS_BIN=/path/to/cli` verifies against a specific build.

Which CLI a beat reaches matters: locally an installed `crewhaus` on PATH wins,
while CI (which has none) falls through to the sibling `factory` checkout's
source. When factory `main` carries an unreleased behaviour change, the two
disagree and only CI is authoritative — beats track factory `main`. This is live
right now for the `expert`/`trader` `--check` beats (PR #345, unreleased): they
are `expectedExit: 0` for factory `main`, and report `exit 1 (want 0)` against an
installed `crewhaus` ≤ 0.4.0 until 0.4.x ships. Reproduce the CI result with
`CREWHAUS_BIN=<shim that runs factory/apps/cli/src/index.ts> bun run drivers:verify`.
