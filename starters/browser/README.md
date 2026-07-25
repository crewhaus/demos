# hello-browser — browser-agent vertical slice

Minimal `target: browser` example: an agent that drives a headless Chromium via
`Navigate`, `Screenshot`, `FindElement`, `Click`, and `Type` tools to complete a
short user task (e.g. "what does this page say?", "find the CTA and click it").

## Run it

```bash
cd starters/browser                                     # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist --check     # writes dist/agent.ts + a pinned package.json, installs, boots to the prompt gate
bun add --cwd dist playwright                           # playwright is an OPTIONAL peer dep of the chromium backend
bun dist/node_modules/.bin/playwright install chromium   # one-time, ~150MB browser binary

# one turn, no REPL — the CI shape
ANTHROPIC_API_KEY=sk-... bun dist/agent.ts --prompt "Take ONE screenshot and tell me what this page says."

# or, on a TTY: a REPL that keeps one live browser context across turns
ANTHROPIC_API_KEY=sk-... bun dist/agent.ts
```

Two things about the 0.4.0 driver, both of which the spec's comments also record:

- **Chromium is always headless.** `@crewhaus/computer-use-driver` launches with
  `headless: true`, and neither the bundle nor the CLI passes `playwrightOptions`
  to override it — there is no `BROWSER_HEADLESS` knob and no window to watch.
  The JSON events on stdout (`browser_start`, `navigated`, `browser_done`) plus
  the agent's answers are the output.
- **Every request routes through a DNS-pinning SSRF proxy.** Loopback and RFC1918
  targets answer `403 ssrf-pinning-proxy: blocked target IP …`, and chromium
  launches with `proxy.bypass: "<-loopback>"` specifically so `127.0.0.1` cannot
  dodge it. `startUrl` — and anything the agent `Navigate`s to — has to be a
  public host. A blocked URL still emits `{"kind":"navigated"}`, because
  `page.goto()` resolves on a non-2xx, so trust the screenshot over the event.

`crewhaus run crewhaus.yaml` accepts a browser spec too, but it is **single-turn**:
it needs `--prompt <text>` or a prompt piped on stdin (bare, on a TTY, it exits
with `no prompt — pass --prompt <text> or pipe input on stdin`) and it rejects
`--resume`/`--continue`. It also resolves `playwright` from the CLI's own install
rather than from this directory, so a `bunx`- or npm-global-installed CLI reports
`Playwright not installed` even with `dist/node_modules/playwright` sitting right
here. The compiled bundle above is the path that works from a fresh copy.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile starters/browser
bun run run starters/browser        # pipe a prompt in, or get a REPL on a TTY
```

Both scripts take a path relative to the repo root, not a bare starter name.
`run` boots the bundle against whichever `playwright` the workspace resolves, so
that build's chromium has to be downloaded once — the launch error names the
exact `playwright install` command when it isn't.

</details>

See [`walkthroughs/10-browser-agent.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/10-browser-agent.md) for the
narrative walkthrough, screenshot pipeline, and selector strategy.
