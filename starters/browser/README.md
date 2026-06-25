# hello-browser — browser-agent vertical slice

Minimal `target: browser` example: an agent that drives a Chromium browser via
`Screenshot`, `FindElement`, `Click`, and `Type` tools to complete a
short user task (e.g. "fill out this form, click submit").

## Run it

```bash
cd starters/browser                                 # if copied elsewhere, cd into that copy
bunx crewhaus compile crewhaus.yaml -o dist         # writes dist/agent.ts
ANTHROPIC_API_KEY=sk-... bunx crewhaus run crewhaus.yaml  # launches Chromium
```

The browser runs headed by default; set `BROWSER_HEADLESS=1` for CI.

<details><summary><strong>Contributors</strong> — in-tree dev loop</summary>

From the demos repo root (resolves the sibling `../factory` checkout and loads `demos/.env`):

```bash
bun run compile browser
bun run run browser
```

</details>

See [`walkthroughs/10-browser-agent.md`](https://github.com/crewhaus/demos/blob/main/walkthroughs/10-browser-agent.md) for the
narrative walkthrough, screenshot pipeline, and selector strategy.
