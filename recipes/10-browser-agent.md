---
test:
  spec: hello-browser/crewhaus.yaml
---

# Recipe 10 — Browser Agent

Build a computer-use agent that drives a chromium browser via
`Screenshot`, `FindElement` (vision-grounded bounding boxes), `Click`,
`Type`, `Key`, and `Scroll`. The same pattern works against the
bundled Playwright chromium for tests and against a remote CDP-over-
WebSocket browser for production.

You'd reach for `target: browser` when:

- The agent must **interact with a UI**, not an API — booking a
  flight, filling a form, scraping a site that fights against
  scrapers.
- You want **vision grounding** rather than DOM selectors — "click
  the blue submit button under the title" rather than `#submit-btn`.
- The work is **deterministic and short-lived per task** — a model
  can complete the work in ≤30 actions.

If the work has a stable API behind it, prefer a CLI agent with HTTP
tools. If you need full desktop automation (not just browser), see
the `host` backend caveats below.

<details>
<summary><strong>Architectural context</strong> — browser tools are the largest trust-surface expansion in any target shape</summary>

The category of high-trust-surface tools — **browser, code
execution, MCP servers, and external search** — is widely flagged as
the set that "materially increases attack and compliance surface" — Microsoft recommends isolation and explicit
approvals; OpenAI distinguishes hosted from local MCP and emphasizes
guardrails; Azure documents that Bing grounding sends data outside the
usual compliance boundary. Of those four, **browser** is the one
where a single action — a single `Click` on the wrong button — can
exfiltrate credentials, post to social media as the logged-in user,
or initiate an irreversible purchase.

The Pillar 3 implications are direct ([CLAUDE.md](https://github.com/crewhaus/factory/blob/main/CLAUDE.md)):

- The `browser` target's tool surface (`Click`, `Type`, `Key`,
  `Scroll`) is uniformly destructive. The default verdict `ask`
  converts to `deny` outside an interactive REPL, which is the
  correct default — but means production browser agents need explicit
  `alwaysAllow` rules with **tight pattern scopes**. `Type("*")` is
  almost never the right rule; `Type` rules should bound the form
  fields the agent is allowed to touch.
- Every page the browser loads is **externally-controlled content**.
  Page text reaches the model through the same path as MCP responses
  — the `boundary-classifier` treats it as `TrustOrigin: "tool"` (the
  tool result origin), so prompt-injection content inside the page
  body is detected before it reaches the model call. Disabling that
  classifier for speed is a Pillar 3 regression, full stop.
- The Anthropic Computer Use research shipped a similar `Screenshot
  → FindElement → Click` pattern and surfaced the same lesson: vision
  grounding is more robust than DOM selectors *and* harder for an
  attacker to manipulate via injected DOM, because the model is
  scoring the rendered pixels.

If you find yourself loosening permissions because the agent "needs
to click around freely," reframe the task as a workflow with explicit
named steps and a permission rule per step. Open-ended browsing is
the production-incident shape; bounded automation is the production
shape.

</details>

## Prerequisites

- [Recipe 01 — CLI Coding Agent](01-cli-coding-agent.md) for the
  underlying chat-loop semantics.
- [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md) —
  `Click`/`Type`/`Key`/`Scroll` are destructive; permission rules
  matter.
- Playwright's chromium binary (auto-installed by `bun install` in
  this repo via `playwright-core`).

## The smallest spec

The bundled example [`hello-browser/crewhaus.yaml`](../hello-browser/crewhaus.yaml):

```yaml
name: hello-browser
target: browser
agent:
  model: claude-sonnet-4-6
  instructions: |
    You drive a chromium browser. Take ONE screenshot, find the
    target element, click its center coordinates, take ONE more
    screenshot to verify, then end your turn with a 1-sentence
    summary of what you did.
driver:
  backend: chromium
  viewport:
    width: 1024
    height: 720
  startUrl: http://127.0.0.1:7325/
groundingModel: claude-sonnet-4-6
permissions:
  mode: default
  rules:
    - type: alwaysAllow
      pattern: Screenshot
    - type: alwaysAllow
      pattern: FindElement
    - type: alwaysAllow
      pattern: Click
    - type: alwaysAllow
      pattern: Type
    - type: alwaysAllow
      pattern: Key
    - type: alwaysAllow
      pattern: Scroll
```

The shape:

- **`driver.backend:`** — `chromium` (Playwright bundled),
  `remote` (CDP WebSocket URL), or `host` (xdotool on Linux, cliclick
  on macOS — read carefully before using; covered below).
- **`driver.viewport:`** — width × height. The browser launches at
  this size and **everything else is layered on this coordinate
  space** — that's why `Click(x, y)` is deterministic across runs.
- **`driver.startUrl:`** — what the browser opens to. Often this
  is a per-task URL passed at run time via `--start-url <url>`.
- **`groundingModel:`** — the model used by `FindElement` to map a
  natural-language description to coordinates. Defaults to the
  agent's model; override if you want a faster/cheaper grounding model.
- **`permissions.rules:`** — destructive tools (everything except
  `Screenshot` and `FindElement`) must be `alwaysAllow` for the agent
  to drive without prompting.

## Compile and run

Compile the spec to a standalone TypeScript file:

```bash
bun run compile hello-browser   # writes hello-browser/dist/agent.ts
```

The output is a ~100-line `dist/agent.ts` you could have written by
hand — same pattern as [Recipe 01 — Step 2](01-cli-coding-agent.md).
Open it; nothing magic.

To actually drive a browser you need two things the compile doesn't
provide: a page at the spec's `startUrl` (`http://127.0.0.1:7325/`),
and an `ANTHROPIC_AUTH_TOKEN` so the model can call out. The example
ships with both a fixture page and a one-shot smoke that wires
everything up.

### Run it manually (two terminals)

In **terminal A**, start the bundled fixture — a single-page app with
a green Submit button whose state flips on click:

```bash
bun scripts/section-25-fixture-server.ts
# [fixture] listening on http://127.0.0.1:7325/
```

In **terminal B**, invoke the compiled agent with a task:

```bash
set -a; source .env; set +a    # exports ANTHROPIC_AUTH_TOKEN
bun run run hello-browser -- --prompt "Click the green Submit button on the page."
```

The agent takes a `Screenshot`, calls `FindElement("the green Submit
button")` to get a bounding box, calls `Click(x, y)` at the center,
takes a verifying `Screenshot`, and ends its turn. JSON events land
on stdout:

```jsonl
{"kind":"browser_start","backend":"chromium"}
{"kind":"navigated","url":"http://127.0.0.1:7325/"}
{"kind":"browser_done","finalText":"Clicked the Submit button. The page now shows BROW_SMOKE_OK."}
```

Confirm the click landed by re-fetching the fixture page — the
marker flips from `PENDING` to `BROW_SMOKE_OK`:

```bash
curl -s http://127.0.0.1:7325/ | grep -o 'BROW_SMOKE_OK\|PENDING'
```

Screenshots from the run land under `.crewhaus/screenshots/<runId>/`
so you can scroll back through what the agent saw at each step.

### Run it as a one-shot smoke

If you'd rather skip the two-terminal dance, the `section-25` smoke
boots the fixture, compiles the example, runs the agent, asserts on
the post-click DOM, and tears everything down — the same path CI
exercises:

```bash
bun run smoke:section-25
# [smoke] OK: fixture page shows BROW_SMOKE_OK — Submit click landed
# Section 25 BROW smoke PASS
```

### Point it at your own page

Pointing the spec at a different URL is a one-line change to
`driver.startUrl`, then `bun run compile hello-browser` again and
`bun run run hello-browser -- --prompt "..."` for whatever's on that
page. The fixture exists only to give the recipe something
deterministic to click — anything Chromium can render works.

## The vision-grounding loop

The recommended action pattern is **always**:

1. `Screenshot()` — capture the current viewport.
2. `FindElement(description)` — ask the grounding model where the
   target element is. Returns `{ box: { x, y, w, h }, center: { x, y } }`.
3. `Click(center.x, center.y)` — click the element.
4. `Screenshot()` — verify the action.
5. Decide what's next based on the new screenshot.

The pattern is deterministic-ish: same viewport + same starting state
yields the same coordinates. Variance comes from the grounding model
(not always the same coordinate for "the blue button") and from
animations (the button might not be in the same place mid-fade).

Anti-patterns:

- **Chained clicks without verifying.** A click that misses leaves
  the next click in the wrong place. Always screenshot after.
- **Using DOM selectors via JavaScript.** The browser target
  intentionally doesn't expose `evaluate()` — vision grounding is
  the contract. If you want selectors, use Playwright directly with
  a CLI agent calling `Bash`.
- **Pages with infinite scroll.** Cap scroll attempts (`Scroll` 5
  times max) before declaring "not found".

## Tools the runtime injects

| Tool                                       | Permissions      | Behavior                                                              |
| ------------------------------------------ | ---------------- | --------------------------------------------------------------------- |
| `Screenshot()`                             | safe (no rule)   | Returns a PNG image block.                                            |
| `FindElement(description: string)`         | safe (no rule)   | Returns `{ box, center }` of the best match, or `null` if not found.  |
| `Click(x: number, y: number)`              | destructive      | Mouse-down + mouse-up at coords.                                      |
| `Type(text: string)`                       | destructive      | Types the string into the focused element.                            |
| `Key(combo: string)`                       | destructive      | e.g. `"Enter"`, `"Cmd+A"`, `"Tab"`.                                   |
| `Scroll(dx: number, dy: number)`           | destructive      | Scrolls the viewport.                                                 |

Plus the chat-loop defaults (`Read`, `Write`, etc.) if you add them
to `tools:`. Most browser agents don't need filesystem tools.

## Permissions posture

`Click` / `Type` / `Key` / `Scroll` declare `destructive: true`. In
the `default` permission mode, **destructive tools require explicit
allow rules** — without them, every action prompts. Production browser
agents need the `alwaysAllow` block in the example above.

If you want **task-scoped** destructive permissions ("only allow Click
on this domain"), use pattern arguments:

```yaml
permissions:
  rules:
    - type: alwaysAllow
      pattern: Click(*)
    - type: alwaysAllow
      pattern: Type(*)
    - type: alwaysDeny
      pattern: Type(* password*)   # never type into a password field
```

Pattern arguments for browser tools match against the tool's input
JSON; the runtime checks each rule in deny > ask > allow order.

For multi-tenant browser agents, see [Recipe 29](29-permissions-deep-dive.md)
for the full rule grammar.

## Backends

### `chromium` (default)

Playwright launches a headless Chromium per run. Fast, sandboxed,
consistent across hosts. Cost: ~150MB memory per browser; ~1s startup.

### `remote`

Connect to an external browser via CDP WebSocket:

```yaml
driver:
  backend: remote
  cdpUrl: ws://browser.internal:9222/devtools/browser/<browserId>
```

Useful for:

- A persistent browser farm (browserless.io, Selenoid, your own).
- Sharing one browser across many runs (cookie / session persistence).
- Geo-located browsers (a browser in EU for a task targeting EU
  content).

### `host` — **production-unsafe**

`host` invokes `xdotool` (Linux) or `cliclick` (macOS) against the
user's actual desktop. This drives the user's *real* mouse and keyboard.

**Do not** use this in production for untrusted tasks. It's the
right backend for:

- Local development against a real browser the developer is watching.
- Pair-programming a UI-test recording.

For multi-tenant or remote-input scenarios, use `chromium` or
`remote` — host backend has no isolation between agent and the rest
of the desktop.

## Event log

Browser-specific events flow into the JSONL log:

```bash
SESSION=$(ls -t .crewhaus/sessions/sess_*.jsonl | head -1)
jq -c 'select(.kind | startswith("browser_"))' "$SESSION"
```

| Subkind                 | Payload                                       |
| ----------------------- | --------------------------------------------- |
| `browser_session_start` | `{ backend, viewport, startUrl }`              |
| `browser_screenshot`    | `{ width, height, hash }`                     |
| `browser_action`        | `{ tool, args, latencyMs, success }`          |
| `browser_navigation`    | `{ url, method: "click" \| "goto" \| "redirect" }` |
| `browser_session_end`   | `{ reason }`                                  |

Screenshots are stored under `.crewhaus/screenshots/<runId>/` (PNG)
and referenced from the JSONL by hash. This makes a 30-action run's
log human-reviewable: each `tool_use` is followed by a screenshot
event with a clickable hash.

## Things that look like browser but aren't

| Symptom                                                                | Wrong shape  | Right shape                                |
| ---------------------------------------------------------------------- | ------------ | ------------------------------------------ |
| Site has a documented API.                                             | browser       | CLI with HTTP tools                        |
| Browser **and** a phone-call UI.                                       | browser       | [voice](09-voice-agent.md) + browser combo |
| Long-running session (hours).                                          | browser       | [graph](05-stateful-graph.md) with HITL    |
| Scraping at scale.                                                     | browser       | [batch](08-batch-worker.md) per URL         |

Browser is for **medium-sized, deterministic, vision-grounded** UI
work — a coverage gap that pure HTTP automation can't fill.

## Production knobs

- **Block third-party requests.** `driver.blockOrigins:
  ["https://*.doubleclick.net", ...]` for ad / analytics / tracker
  domains. Smaller attack surface and faster page loads.
- **Cookies.** `driver.cookies: [...]` to pre-populate session cookies.
  Stored in `.env` via `$COOKIE_*` references.
- **User-agent override.** `driver.userAgent: "..."` if the target
  site sniffs.
- **Recording.** `driver.recordingPath: ./recordings/` produces
  Playwright-format trace files for replay.

## What to read next

- **Sandbox a browser agent.** [Recipe 30 — Sandboxed Code Execution](30-sandboxed-code-execution.md)
  for running the browser in a docker sandbox.
- **Permissions deep dive.** [Recipe 29 — Permissions Deep Dive](29-permissions-deep-dive.md).
- **Voice + GUI multimodal.** [Recipe 09 — Voice Agent](09-voice-agent.md) +
  this one composes for kiosk UX.
- **Eval the browser agent.** [Recipe 12 — Eval Harness](12-eval-harness.md)
  — graders that assert on final screenshots or URLs.

## Pointers to source

- **Example:** [`hello-browser/crewhaus.yaml`](../hello-browser/crewhaus.yaml).
- **Codegen:** [`packages/target-browser-driver`](https://github.com/crewhaus/factory/blob/main/packages/target-browser-driver).
- **Computer-use driver:** [`packages/computer-use-driver`](https://github.com/crewhaus/factory/blob/main/packages/computer-use-driver).
- **Screenshot tool:** [`packages/tool-screen-capture`](https://github.com/crewhaus/factory/blob/main/packages/tool-screen-capture).
- **Mouse/keyboard tools:** [`packages/tool-mouse-keyboard`](https://github.com/crewhaus/factory/blob/main/packages/tool-mouse-keyboard).
- **Vision grounding:** [`packages/tool-vision-grounding`](https://github.com/crewhaus/factory/blob/main/packages/tool-vision-grounding).
- **Spec schema (browser variant):** [`packages/spec/src/index.ts`](https://github.com/crewhaus/factory/blob/main/packages/spec/src/index.ts) (search `browserSchema`).
- **Module catalog reference:** §25, §30 in [MODULE-CATALOG.md](https://github.com/crewhaus/factory/blob/main/docs/MODULE-CATALOG.md).
