# trader-advisor — a self-improving trading research advisor

An advisor that starts with **zero track record** and earns one. Its only
eval assets on day 0 are a seed exam — 10 costs-and-constraints questions
in `eval/dataset.jsonl` and an `llm_judge` rubric in `eval/graders.yaml`,
wired in as `learning.exam` and sat with `/exam`. Everything past that it
writes itself: it studies real markets and what successful traders
publish, writes **playbooks** to its own wiki, tests every playbook with
**simulated trades at real (delayed) prices under real fees and
constraints**, and lets the resulting track record — not enthusiasm —
decide when it has earned the right to send you trade alerts. The journal
that record lives in becomes the second dataset mechanically —
`export_dataset`, below.

> **This is a research and learning harness, not financial advice.** It
> cannot execute real trades — no tool for that exists in the spec. Only
> you can trade, and anything it surfaces deserves your own judgment.

Two kinds of confidence, both measured:

- **Knowledge** — the `learning:` exam (`eval/dataset.jsonl` +
  `eval/graders.yaml`): costs, constraints, risk math. Failed questions
  auto-log as knowledge gaps and get studied first.
- **Track record** — the paper broker's `performance` tool computes a
  **confidence gate in code** (min closed trades, positive net expectancy
  after fees, profit factor, bounded drawdown). The verdict can't be
  faked by the prompt, and the daemon's standing orders require it before
  any alert — until it passes, the advisor paper-trades and studies in
  silence. (Want the *sending* structurally gated too, not just the
  verdict? Wire a `PreToolUse` hook or recipe 67's approvals on
  `SendMessage`.)

> Walkthrough:
> [73 — The trading advisor](../../walkthroughs/73-trading-advisor.md)
> walks this starter end to end, including how the trade journal becomes
> an eval dataset mechanically.

## The loop

```
      curriculum.md + logged gaps ──► STUDY (allowlisted sources, 13Fs,
            ▲                          published research) ──► wiki playbooks
            │                                                    (cited, scored)
   exam failures, broker                                              │
   rejections, losing streaks                                         ▼
            ▲                                    SCAN (cron, market hours):
            │                                    quotes → setup? → paper trade
            │                                                         │
   REFLECT: reconcile playbooks ◄── journal stats ◄── paper broker ◄──┘
   with what the journal says       (P&L after real fees, R-multiples,
            │                        per-playbook expectancy)
            ▼                                 │
   confidence gate (in code) ── passes? ──► Slack alert → operator trades
            │                                  │            (or doesn't)
            ▼                                  ▼
   export_dataset → eval assets      "filled 100 @ 187.42" → live book →
   flywheel → gated spec patches      sim-vs-real drift → more learning
```

Two shapes, one hosted brain (`thredz:` is emit-wired on both since 0.4.0):

- **`crewhaus.yaml` (`target: cli`)** — the interactive advisor. Ask it
  things, drive `/study`, `/reflect`, `/exam`, review the journal, rate
  its answers.
- **`daemon.yaml` (`target: channel`)** — the always-on advisor. A 6h
  heartbeat studies/reflects and refreshes the dashboard; a market-hours
  cron scans the watchlist, paper-trades written playbooks, and — once
  the gate passes — alerts you in Slack. Your 👍/👎 reactions and
  "filled …" replies feed straight back into its learning.

### One brain is a choice

Since 0.5.0 the sharing is explicit — both specs name the same key and the
same wiki space:

```yaml
thredz: { api_key: $THREDZ_API_KEY, space: trader-advisor, goals: true }
```

A Thredz **space** is a memory boundary inside your account. Scoping both
specs to `trader-advisor` is what makes "two faces of one advisor" literal:
the playbooks the heartbeat studies into are the playbooks the REPL recalls,
the `watchlist` and `ops-config` you set interactively are the ones the market
scan reads, and both write the same `dashboard` article. (The trade journal
isn't in the wiki — it's the broker's own `.paper-broker/` state, shared
because both processes run from this directory.)

The shared key is load-bearing, not laziness. An `individual` space is
readable only by the key that owns it, and **one individual space per key is
a hard Thredz limit** — so per-agent *private* memory means a key per agent,
and a server process per agent, because `thredz-mcp` reads one
`THREDZ_API_KEY` per process. That is the [expert starter](../expert)'s
shape; this advisor deliberately wants the opposite.

Two consequences worth knowing:

- **Spaces are a Pro/Scale feature.** Free and Starter have none — there,
  delete `space:` from both specs and the advisor uses the unspaced legacy
  wiki exactly as it did before 0.5.0. Nothing else in this starter changes.
- **Inside a space, the space's type decides visibility** (`shared` = every
  wiki-enabled key on the account; `individual` = this key only), so the
  `visibility:` knob no longer applies. The type is fixed when the space is
  created — see `.env.example` for creating it.

## Prerequisites

| Need | Why | Where |
|---|---|---|
| **Anthropic key** | run the agent | `ANTHROPIC_API_KEY` |
| **Thredz API key with a wiki grant** | the brain + the dashboard | [thredz.crewhaus.ai](https://thredz.crewhaus.ai) — create a key, grant wiki `read-write` via `/api/wiki/access`. One key serves both specs |
| **A `trader-advisor` wiki space** | the memory boundary both specs share | Pro/Scale only — create it first (see `.env.example`), or drop `space:` from both specs to use the unspaced legacy wiki |
| **Search provider** (`CREWHAUS_SEARCH_*`) | `/study` reads the live web | any provider CrewHaus supports (brave, tavily, …) |
| **Slack app creds** (daemon only) | alerts + replies + reactions | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |

No brokerage account and no market-data key: the paper broker pulls free
delayed quotes (Yahoo Finance for equities/ETFs, Coinbase spot for crypto)
and fails honestly when a feed is down — it never invents a price.

## Run it (interactive)

```bash
cd starters/trader
cp .env.example .env        # ANTHROPIC_API_KEY + THREDZ_API_KEY (+ search)
bunx crewhaus run crewhaus.yaml
```

Then, in the REPL:

```
> What would a round trip on 50 shares of AAPL actually cost me?
> /study                       # first rungs: the cost stack
> /exam                        # sit the costs-and-constraints exam
> Scan SPY, AAPL, BTC-USD and paper trade any playbook that triggers.
> Show the journal and the performance report.
```

Cold start is honest: an empty wiki means "I don't know yet", no playbooks
means no trades, and the performance report says the gate is far from
passing. That arc — study → playbooks → journal → gate — *is* the demo.

## Run it (always-on daemon)

```bash
bunx crewhaus compile daemon.yaml -o dist
bun install --cwd dist          # first run only
bun dist/daemon.ts              # SLACK_* + a public URL for /slack/events
```

Run it from **inside this directory** — the spec wires the broker by the
relative path `mcp/paper-broker.ts`, so the daemon's working directory
must be the harness. (That's also why `crewhaus dev daemon.yaml` doesn't
work for this starter: dev runs the bundle from a temp directory where
the relative path can't resolve. And `crewhaus run` never serves channel
daemons at all — it only drives the cli and browser shapes.) Use
`crewhaus channel provision daemon.yaml --base-url <public-url>` to wire
the Slack app; see walkthrough 03.

First-run setup in Slack: invite the bot to your alerts channel and tell
it `alerts here: slack:<teamId>:<channelId>` — it stores the destination
in the `ops-config` wiki article. Add symbols with "watchlist: SPY, AAPL,
BTC-USD" and it writes the `watchlist` article the scans read.

## The paper broker (the referee)

[`mcp/paper-broker.ts`](mcp/paper-broker.ts) is a zero-dependency stdio
MCP server — ~700 lines you can read in one sitting. Every constraint is
**enforced in code, not asked of the prompt**:

| Rail | What it does |
|---|---|
| Real fees | half-spread + slippage both ways; SEC §31 + FINRA TAF on equity sells; 60 bps taker on crypto (all env-tunable, sourced in [sources/costs-and-constraints.md](sources/costs-and-constraints.md)) |
| Cash account | buys spend **settled** cash only; equity proceeds settle T+1 — good-faith violations are structurally impossible |
| Market hours | equity fills 9:30–16:00 ET Mon–Fri only; crypto 24/7 |
| Risk rail | every buy requires a stop; initial risk ≤ 1% of equity; position ≤ 20% concentration; no leverage |
| Drawdown halt | 15% below high-water blocks new buys until recovery |
| Confidence gate | `performance` computes `alertsUnlocked` from ≥40 closed trades, positive net expectancy, profit factor ≥ 1.3, drawdown ≤ 15% |
| Wash-sale warning | re-buying within 30 days of a realized loss flags the tax consequence |
| Live book | `record_live_fill` logs the trades *you* report making — a separate ledger, never mixed with paper — so sim-vs-real drift is measurable |

And the punchline for the eval story: **`export_dataset` turns the closed
journal into `eval/journal-dataset.jsonl` mechanically** — winners become
gold samples, losers become mutation hints with the loss preserved as
metadata. Your performance writes your dataset.

## Files

```
trader/
  crewhaus.yaml            interactive advisor (target: cli)
  daemon.yaml              always-on advisor (target: channel) — heartbeat + market-scan cron
  mcp/paper-broker.ts      the referee: fills, fees, constraints, scoring, confidence gate
  curriculum.md            the trading learning ladder (agent-editable)
  eval/dataset.jsonl       seed costs-and-constraints exam (grows over time)
  eval/graders.yaml        the exam rubric (llm_judge; numbers must be right)
  sources/costs-and-constraints.md   hand-checked 2026 fee/constraint table
  .env.example             keys: Anthropic, Thredz, search, Slack + broker tuning
```

## Point it at your markets

The mechanism is market-agnostic; the seed content is US equities + crypto:

1. `learning.domain`, the persona paragraph, and `curriculum.md` set the
   scope. Narrow it (e.g. "large-cap ETFs only") or extend it.
2. The broker models equities and crypto. Options/futures are extension
   targets — the fee table in `sources/` has the numbers; add asset
   classes to `mcp/paper-broker.ts` (it's dependency-free on purpose).
3. Tune the rails (`PAPER_*`, `CONFIDENCE_*`) in `.env` — tighter is
   always allowed; looser deserves a written reason in the wiki.

## Notes & limits

- **Delayed data.** Quotes are delayed/EOD-grade; the advisor learns
  structure and discipline, not microsecond timing. Polling too fast
  meets HTTP 429 — the scans are deliberately half-hourly. For real-time
  paper fills against live books, the upgrade path is a free Alpaca
  paper-trading account (swap the fill source in `mcp/paper-broker.ts`;
  it's dependency-free on purpose).
- **Long-only cash account.** Shorting, options, and futures are not
  modeled (yet) — see the fee table for what they'd cost.
- **Paper fills flatter you.** Even this broker's conservative fills hide
  queue position, partial fills, and fast markets. That's why the live
  book and sim-vs-real drift exist: measured humility.
- **The gate is the product.** If you find yourself lowering
  `CONFIDENCE_MIN_TRADES` to get alerts sooner, you've re-invented the
  problem this starter exists to solve.
