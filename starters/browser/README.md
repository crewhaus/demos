# hello-browser — browser-agent vertical slice

Minimal `target: browser` example: an agent that drives a Chromium browser via
`Screenshot`, `FindElement`, `Click`, and `Type` tools to complete a
short user task (e.g. "fill out this form, click submit").

## Run it

From the repo root:

```bash
bun install
bun run compile browser                       # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bun run run browser  # launches Chromium
```

The browser runs headed by default; set `BROWSER_HEADLESS=1` for CI.

See [`recipes/10-browser-agent.md`](../recipes/10-browser-agent.md) for the
narrative walkthrough, screenshot pipeline, and selector strategy.
