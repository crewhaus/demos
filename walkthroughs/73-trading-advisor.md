---
test:
  spec: starters/trader/crewhaus.yaml
  packages:
    - packages/memory-service
    - packages/wiki-store
    - packages/tool-wiki
    - packages/default-skills
    - packages/eval-runner
    - packages/mcp-host
    - packages/target-channel-bot
---

# Recipe 73 — The trading advisor: when the market is your grader

**Pillar:** Pillar 2 — eval is active, not passive (ground truth you don't
have to label).
**Catalog modules:** `memory-service` / `wiki-store` / `tool-wiki` (the
Thredz brain), `default-skills` (the `learning-loop` skill), `mcp-host`
(the paper broker), `eval-runner`, `target-channel-bot` (heartbeat +
schedule + Slack alerts).
**Shipped:** crewhaus 0.4.0 (`thredz:` on the channel shape, `schedule:`,
plus the 0.2.0–0.3.0 eval/learning fabric).
**Starter:** [`starters/trader/`](../starters/trader/README.md).

> **Reality check, up front.** This is a research and learning harness —
> not financial advice, and not an auto-trader. The spec contains **no
> tool that can execute a real trade**; the harness paper-trades to learn,
> and once *measured* confidence exists it *suggests* — the human decides.
> Markets are adversarial; most short-horizon retail edges are smaller
> than the cost stack. This recipe's whole design absorbs that fact
> instead of hiding it.

[Recipe 72](72-zero-to-improving.md) bootstrapped evals from **human
ratings** — you were the grader. Some domains hand you something even
better: an **objective, delayed ground truth**. A trading thesis is
scoreable by reality itself — realized profit-and-loss *after costs*, a
number nobody has to label. This recipe builds an advisor whose eval
assets are earned three ways at once, none of them hand-written:

```
   knowledge   →  a living exam on costs/constraints/risk   (llm_judge)
   track record →  a paper-trade journal scored by the market (in code)
   human trust  →  your ratings + reported real fills        (distill)
```

(New to those words? A **grader** is any function that scores an answer
— here the most important one is realized P&L, computed in code. A
**dataset** is the file of scored cases; an **`llm_judge`** is a grader
that scores prose against a rubric by asking a model; **distill** turns
your ratings into both. [Recipe 72's five-sentence
vocabulary](72-zero-to-improving.md#the-vocabulary-in-five-sentences) is
the two-minute read if any of this is new.)

You'd reach for this shape whenever outcomes are **objective but
delayed** — trading is the worked example, but demand forecasting, ad
creative testing, sports modeling, and capacity planning all rhyme.

You'd reach for this when:

- You want a harness that **researches a live domain continuously**
  (what's published, what successful practitioners disclose) and turns it
  into testable playbooks rather than vibes.
- You want **trial-and-error learning with real constraints** — fees,
  settlement, market hours, risk limits — enforced by a referee the
  agent can't sweet-talk.
- You want an always-on advisor that **earns** the right to ping you,
  and gets *more* accurate from every "filled 100 @ 187.42" you send back.

## Prerequisites

- [Recipe 64 — The self-teaching expert](64-self-teaching-expert.md) —
  the `thredz:` + `learning:` fabric this builds on (wiki, curriculum,
  gaps, `/study` `/reflect` `/exam`).
- [Recipe 62 — Response ratings](62-response-ratings.md) and
  [Recipe 56 — the flywheel](56-self-improvement-flywheel.md) — the
  ratings→dataset→gated-improvement machinery.
- [Recipe 03 — Slack Bot](03-slack-bot.md) (+ [Recipe 00](00-network-security-primer.md))
  for the daemon's channel plumbing.

## The architecture

```
      curriculum.md + logged gaps ──► STUDY (sec.gov, ssrn, 13Fs,
            ▲                          published research) ──► wiki PLAYBOOKS
            │                                                  (cited, scored)
   exam failures, broker                                            │
   rejections, losing streaks                                       ▼
            ▲                                   SCAN (cron, market hours):
            │                                   quotes → setup? → paper trade
            │                                                       │
   REFLECT: reconcile playbooks ◄── journal stats ◄── PAPER BROKER ◄┘
   with what the journal says       (P&L after real fees, R-multiples,
            │                        per-playbook expectancy)
            ▼                                │
   CONFIDENCE GATE (in code) ── passes? ──► Slack alert ──► operator trades
            │                                   │              (or doesn't)
            ▼                                   ▼
   export_dataset → eval assets      "filled 100 @ 187.42" → live book →
   flywheel → gated spec patches      sim-vs-real drift → more learning
```

The [starter](../starters/trader/README.md) is two specs sharing one
hosted brain — [`crewhaus.yaml`](../starters/trader/crewhaus.yaml)
(interactive cli) and [`daemon.yaml`](../starters/trader/daemon.yaml)
(always-on Slack) — plus one ~700-line file that makes the whole recipe
honest.

## 1 — The referee: a paper broker the agent can't sweet-talk

The eval insight of this recipe: **when ground truth is objective, put
the grader in code, outside the model's reach.**
[`mcp/paper-broker.ts`](../starters/trader/mcp/paper-broker.ts) is a
zero-dependency stdio MCP server ([Recipe 13](13-mcp-servers.md) pattern:
`command: bun`, `args: ["mcp/paper-broker.ts"]`, tools arrive prefixed as
`broker__*`). It fills paper orders at real delayed prices — Yahoo
Finance for US equities/ETFs, Coinbase spot for crypto — and never, under
any circumstance, invents a price: a dead feed degrades the tool call
with an error.

Every fill pays what a 2026 US retail cash account actually pays, and
every constraint is enforced in code, not asked of the prompt:

| Rail | Enforced behavior |
| ---- | ----------------- |
| The cost stack | half-spread + slippage both ways; SEC §31 fee ($20.60/$1M) + FINRA TAF ($0.000195/sh, cap $9.79) on equity **sells**; 60 bps taker on crypto — all env-tunable, sourced with effective dates in [`sources/costs-and-constraints.md`](../starters/trader/sources/costs-and-constraints.md) |
| Cash account | buys spend **settled** cash only; equity proceeds settle T+1 — a good-faith violation is structurally impossible |
| Market hours | equity fills 9:30–16:00 ET Mon–Fri only; crypto 24/7 |
| Risk rail | **no stop, no trade** — and (entry − stop) × qty ≤ 1% of equity, position ≤ 20%, no leverage, long-only |
| Drawdown halt | equity 15% under its high-water mark blocks new buys until recovery |
| Wash-sale warning | re-buying within 30 days of a realized loss flags the deferred tax loss |
| Thesis required | `paper_buy` **rejects** entries without a ≥40-char thesis and a playbook tag — *"the journal is the dataset — a trade without a thesis is an unlabeled sample"* |

That last row is the bridge to everything you learned in Recipe 72: each
closed trade is scored in code — P&L net of all fees, an R-multiple
(P&L ÷ initial risk), and a [0,1] `score` — and appended to a journal.
The rejection messages are teaching moments by design; when the broker
refuses a trade, that's the same constraint a real broker would enforce,
and the advisor is instructed to journal what it learned rather than
argue.

## 2 — The brain: playbooks, not vibes

The knowledge side is [Recipe 64](64-self-teaching-expert.md)'s fabric
pointed at trading. From the cli spec:

```yaml
thredz: { api_key: $THREDZ_API_KEY, goals: true }

learning:
  domain: systematic retail trading of mainstream US markets (equities/ETFs and crypto) under realistic costs and constraints
  curriculum: curriculum.md
  sources:
    ["sec.gov", "finra.org", "cmegroup.com", "*.edu", "ssrn.com", "alphaarchitect.com", "quantocracy.com", "morningstar.com"]
  exam: { dataset: eval/dataset.jsonl, graders: eval/graders.yaml }
```

[`curriculum.md`](../starters/trader/curriculum.md) is a deliberate
ladder: the **cost stack first** (it gates everything), then risk, *then*
strategy families — including a rung on what disclosed sources (13Fs,
investor letters, published backtests) reveal about successful traders
**and the survivorship bias in reading them** — then validation
(overfitting, walk-forward, sim-vs-real drift). Study passes research via
allowlisted primary sources and commit **playbook articles** to the wiki:
entry/exit/sizing rules, cited, confidence-scored, upserted by slug. The
`learning-loop` skill's discipline is *no source, no commit* — on a local
`memory.wiki` backend the tool layer enforces it deterministically
(`wiki_write` rejects uncited bodies); on the hosted Thredz backend used
here it's the skill's standing instruction rather than a hard rejection.
Either way the advisor's operating rule is **trade only written
playbooks**, so strategy drift can't outrun documentation.

"Evaluate algorithms with potential, tune them, or create its own" is
this loop: a playbook is a hypothesis; the journal (tagged per playbook)
is its evidence; `/reflect` reconciles playbooks against their own stats
— tightening rules, demoting what decays, promoting what survives.

## 3 — Day 0, interactively

```bash
cd starters/trader
cp .env.example .env      # ANTHROPIC_API_KEY + THREDZ_API_KEY (+ search keys)
bunx crewhaus run crewhaus.yaml
```

```
> What would a round trip on 50 shares of AAPL actually cost me?   # cost literacy, day one
> /study            # first rungs: the cost stack
> /exam             # sit the seed exam — failures auto-log as gaps
> Research momentum playbooks for liquid ETFs and write one to the wiki.
> Scan SPY, QQQ, BTC-USD and paper trade any playbook that triggers.
> Show me the journal and the performance report.
```

Cold start is honest by design: no playbooks means no trades; the
performance report shows the confidence gate failing on every criterion;
the exam exposes what it hasn't learned. Watching those three fill in —
studies → playbooks → journal → gate progress — *is* the demo.

The seed exam ([`eval/dataset.jsonl`](../starters/trader/eval/dataset.jsonl))
is ten costs-and-constraints questions with load-bearing numbers, graded
by an `llm_judge` rubric ([`eval/graders.yaml`](../starters/trader/eval/graders.yaml))
whose second criterion scores **risk-and-cost awareness** — fluent
answers with wrong fee rates fail. Like Recipe 64's exam, it's alive:
`/reflect` grows it as rungs are mastered, and every failed question
becomes a knowledge gap that the next study pass attacks first.

## 4 — Three graders, no authoring

Here is the recipe's eval story in one table — compare it with Recipe
72's single human-rating loop:

| Signal | Grader | Latency | Where it lives |
| ------ | ------ | ------- | -------------- |
| Knowledge | `llm_judge` exam rubric | minutes | `eval/` (agent-curated) |
| Track record | **the market**, scored in code | days–weeks | the broker's journal |
| Human trust | ratings + corrections → distilled judge | seconds | `.crewhaus/sessions/` → registry |

Two eval lessons this domain teaches better than any other:

**Grade process immediately, outcomes in aggregate.** A single trade's
outcome is mostly noise — a good decision can lose and a bad one can win.
So the *exam and ratings* judge decision quality now (thesis, costs,
sizing, invalidation), while the *journal* judges outcomes only in
statistical quantity (expectancy, profit factor over ≥40 trades). Neither
alone is sufficient; the gate below requires both kinds of confidence.

**The dataset is earned, not written.** When you're ready to feed the
track record into the eval stack:

```bash
# inside the REPL: "export the journal dataset"  → broker__export_dataset
# or watch what it wrote:
cat eval/journal-dataset.jsonl
```

Winning trades become **gold samples** (the thesis that survived reality,
with its R-multiple); losers become **mutation hints** — input plus
failure metadata, never asserted as correct. Recognize the split? It's
exactly [`crewhaus distill`](62-response-ratings.md)'s tag-all policy,
applied by a broker instead of a human.

Both signals then drive the same improvement machinery. The nightly
flywheel runs on your distilled ratings against the exam rubric:

```bash
crewhaus distill --all-sessions --judge --register trader-advisor-ratings
crewhaus flywheel run --dataset registry:trader-advisor-ratings \
  --graders eval/graders.yaml --concurrency 1
```

…and the human-plus-market **union** is one optimize invocation — the
journal export as the dataset, ratings distilled inline on top:

```bash
crewhaus optimize crewhaus.yaml --dataset eval/journal-dataset.jsonl \
  --ratings all --graders eval/graders.yaml --write-back
```

Same strict gate as [Recipe 56](56-self-improvement-flywheel.md) either
way: a spec patch lands only if the pass rate strictly improves with zero
regressions, `permissions` and `model` are untouchable, nothing
auto-merges. One honest asterisk: `optimize`/`flywheel` patch **the cli
spec** (they're `target: cli` commands) — when a patch is accepted,
review the diff and port the instruction changes to `daemon.yaml` by
hand, or the always-on surface quietly stops improving while the
interactive one races ahead.

## 5 — Always on: the daemon

[`daemon.yaml`](../starters/trader/daemon.yaml) compiles the same brain
to a Slack daemon (since 0.4.0 `thredz:` is emit-wired on the channel
shape, so cli and daemon share one hosted wiki). Three temporal surfaces
divide the labor:

```yaml
heartbeat:            # study/reflect rotation + the ops tick, every 6h
  every: 6h
  instructions: |
    ...mark to market, honor breached stops, refresh the dashboard...

schedule:             # the market scan — cron, exchange-timezone aware
  kind: cron
  cron: "*/30 9-15 * * 1-5"
  timezone: America/New_York
  instructions: |
    ...watchlist → setups → paper trade → (gate passes?) → alert...
```

`heartbeat:` ticks get the built-in study rotation prepended
(`learning.study.on_heartbeat`, exactly as in [Recipe 64 §8](64-self-teaching-expert.md#8--on-a-schedule-the-daemon));
the operator instructions then run the **ops tick** — `mark_to_market`,
honor breached stops, refresh the dashboard, export the dataset when ≥5
new trades closed. `schedule:` (0.4.0) is the scan: cron-shaped,
timezone-pinned to the exchange, and deliberately *not* a study tick.
Each tick runs in a fresh session — wake, decide, act, sleep — so
standing state lives in the wiki, not in chat history.

Run it from inside the harness directory:

```bash
bunx crewhaus compile daemon.yaml -o dist
bun install --cwd dist                    # first run only
bun dist/daemon.ts                        # + a public URL for /slack/events
```

Two landmines worth naming. `crewhaus run` never serves channel daemons
(it only drives the cli and browser shapes) — the daemon is always
compile + `bun dist/daemon.ts`, with
[`crewhaus channel provision`](03-slack-bot.md) wiring the Slack app.
And `crewhaus dev` runs its bundle from a temp directory, which breaks
this spec's *relative* `mcp/paper-broker.ts` path — for this starter,
run the compiled daemon from the harness directory as above.

### Alerts are earned, and replies are data

The alert path leans on the gate: the scan instructions require
`broker__performance`'s `confidenceGate.alertsUnlocked` — computed in the
broker from ≥40 closed trades, positive net expectancy after fees, profit
factor ≥ 1.3, drawdown ≤ 15% — before a single `SendMessage` fires. Be
precise about what's enforced where: the *verdict* is computed in code
and cannot be faked, but *consulting it* is a standing order — i.e.
prompt-level. If you want the send itself structurally gated, put a
`PreToolUse` hook ([Recipe 14](14-hooks.md)) or an approval flow
([Recipe 67](67-hitl-approvals.md)) on `SendMessage`. Until the gate
passes, the daemon paper-trades and studies in silence. Proactive sends
are the opt-in `sendMessage` tool
(`agent.tools: [sendMessage]` + an explicit `alwaysAllow: SendMessage`
rule — it's destructive-by-default, so the rule is load-bearing); the
destination routing key lives in the `ops-config` wiki article you set up
by telling the bot `alerts here: slack:<teamId>:<channelId>` once.

An alert is one message: playbook, thesis, entry/stop/target, size under
the risk rail, estimated cost, the playbook's own journal stats, a broker
deep link (e.g. `https://robinhood.com/stocks/AAPL`) — and the line
*"Paper-traded as t00042. If you take it, reply: `filled <qty> @ <price>`"*.
Every alert is mirrored as a paper trade, so the journal scores it even
when you pass.

Your replies close the loop:

- `filled 100 @ 187.42` → `broker__record_live_fill` (a **separate live
  ledger**, never mixed with paper cash) — over time the advisor measures
  **sim-vs-real drift**: your actual fills vs its simulated ones.
- `that one stopped out at 184` → the outcome is journaled against the
  live book, and the lesson goes to the wiki.
- 👍/👎 reactions on its messages → rating signal
  (`feedback.channelReactions: true`). Note the spec uses
  `routing.sessionKey: channel` deliberately — reactions **silently
  no-op under `thread`** ([Recipe 62 §Rating surfaces](62-response-ratings.md#rating-surfaces-beyond-the-cli)).

Two daemon-specific facts from the fine print: `autoDistill` is a
cli-teardown feature and **never fires on a channel daemon** — schedule
`crewhaus distill --all-sessions --register trader-advisor-ratings` from
the daemon's directory (cron, or your flywheel workflow) instead. And
keep the *no source, no commit* discipline even on operational articles —
`dashboard` and `ops-config` cite the broker journal or the operator's
instruction under `## Sources`; that's provenance, not bureaucracy (and
it keeps the same articles portable to a local `memory.wiki` backend,
where the tool layer enforces the section outright).

## 6 — The Thredz dashboard

The operator-facing metrics live in Thredz, driven by two primitives the
daemon already has:

1. **Metric goals.** Each ops tick maintains one goal per metric —
   `trader-equity`, `trader-closed-trades`, `trader-win-rate-pct`,
   `trader-expectancy-cents`, `trader-drawdown-pct`, `trader-fees-usd` —
   created with `goal_write` and **tagged** `["trader-metric",
   "<its-name>"]`, then ticked with `goal_update currentValue`. The tags
   matter: Thredz dashboard cards address goals *by tag* (there is no
   per-name card filter), which is why the daemon's heartbeat
   instructions bake the tagging convention in.
2. **The `dashboard` wiki article** — the narrative view: the equity
   curve over time, drawdown, the per-playbook table, gate status, open
   positions, last five closed trades, the sim-vs-real drift note, and
   what it studied this tick.

Thredz's dashboard surface shows the goals' **latest values** (cards read
current documents; the per-tick trail lives in each goal's activity
history, and the equity *curve* lives in the wiki article). Create the
dashboard once — plain REST, since `thredz-mcp` deliberately ships no
dashboard tools; KPI cards need `aggregationField` to know which number
to show:

```bash
curl -s -X POST https://thredz.crewhaus.ai/api/dashboards \
  -H "Authorization: Bearer $THREDZ_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"trader-advisor","cards":[
    {"title":"Equity (USD)","type":"kpi","dataSource":{"entityType":"goal","filters":{"tag":"trader-equity"}},"display":{"aggregation":"max","aggregationField":"currentValue"}},
    {"title":"Win rate %","type":"kpi","dataSource":{"entityType":"goal","filters":{"tag":"trader-win-rate-pct"}},"display":{"aggregation":"max","aggregationField":"currentValue"}},
    {"title":"Closed trades","type":"kpi","dataSource":{"entityType":"goal","filters":{"tag":"trader-closed-trades"}},"display":{"aggregation":"max","aggregationField":"currentValue"}},
    {"title":"Drawdown %","type":"kpi","dataSource":{"entityType":"goal","filters":{"tag":"trader-drawdown-pct"}},"display":{"aggregation":"max","aggregationField":"currentValue"}},
    {"title":"All metrics","type":"table","dataSource":{"entityType":"goal","filters":{"tag":"trader-metric"},"sort":{"field":"title","order":"asc"}}}]}'
```

View it in the Thredz app (paste your API key):
[thredz.crewhaus.ai/app](https://thredz.crewhaus.ai/app) → Dashboards →
`trader-advisor`, with the `dashboard` wiki article one click away under
Wiki. From then on the harness only updates *data* (goals, the article) —
the dashboard follows.

## 7 — The fee table (why "after costs" is the whole game)

Abridged from [`sources/costs-and-constraints.md`](../starters/trader/sources/costs-and-constraints.md)
— the full note carries sources and effective dates, and the broker's
defaults mirror it:

| Venue | You pay (2026, base retail tier) |
| ----- | -------------------------------- |
| US equities | $0 commission; **sells**: SEC §31 $20.60/$1M + TAF $0.000195/sh (cap $9.79); half-spread 1–5 bps (mega-cap) → 20–100 bps (small-cap), each way |
| Crypto (Coinbase Advanced) | 0.60% taker / 0.40% maker per side + 1–5 bps book spread (BTC/ETH) |
| Options (not modeled) | $0–0.65/contract + OCC $0.025 + ORF + TAF on sells |
| CME micros (not modeled) | ~$0.65–0.95/side all-in; MES fees + 1-tick spread ≈ $2.75 round turn |

A base-tier crypto taker round trip is 1.2% in fees alone — gone before
the market moves — which the advisor's exam makes it *prove it knows*
before the journal makes it *feel* it.

## Gotchas recap

| Gotcha | Rule |
| ------ | ---- |
| Serving the daemon | `crewhaus run` refuses channel specs (it only drives cli/browser targets) — compile + `bun dist/daemon.ts`; and `crewhaus dev` breaks this starter's *relative* broker path (temp-dir cwd), so run from the harness dir |
| Reactions under `thread` sessions | silently no-op; the daemon uses `sessionKey: channel` on purpose |
| `autoDistill` on a daemon | inert (cli teardown only) — schedule `distill --all-sessions --register` |
| `optimize`/`flywheel` are cli-shape commands | accepted patches land on `crewhaus.yaml`; port instruction changes to `daemon.yaml` by hand |
| Delayed quotes | learning-grade, not execution-grade; polling fast meets HTTP 429 — scans are half-hourly on purpose |
| The gate is the product | lowering `CONFIDENCE_MIN_TRADES` to get alerts sooner re-creates the problem this recipe solves; and the *verdict* is code, but consulting it is instructions — hook `SendMessage` for structural enforcement |
| Outcome ≠ process | one trade grades nothing; expectancy over ≥40 trades grades everything |
| `## Sources` discipline | keep it on every wiki article (ops articles cite the broker journal); the local `memory.wiki` backend enforces it mechanically, the Thredz backend by skill instruction |
| Wash sales | re-entering within 30 days of a realized loss defers the tax loss — the broker warns, reality bills |
| Paper flatters | even conservative sim fills hide queue position and fast markets — hence the live book and drift tracking; the upgrade path is a free Alpaca paper account with live-book fills |

## When NOT to use this

- **Real-time or short-horizon execution.** Delayed data + half-hourly
  scans structurally cannot do it — and the cost stack eats most retail
  edges at that horizon anyway. This is a research advisor, not an
  execution engine.
- **As a source of returns you're counting on.** The honest promise is
  *measured* learning: an advisor that knows its costs, sizes soberly,
  and can show you a journal — not alpha on demand.
- **Domains without a scoreable outcome.** If nothing objective ever
  settles a recommendation, you're in [Recipe 72](72-zero-to-improving.md)'s
  human-rating world — use that loop.

## Where to go next

- **The human-graded twin of this recipe:** [Recipe 72 — Zero to
  self-improving](72-zero-to-improving.md).
- **The learning fabric underneath:** [Recipe 64 — The self-teaching
  expert](64-self-teaching-expert.md).
- **The improvement machinery:** [56](56-self-improvement-flywheel.md) ·
  [62](62-response-ratings.md) · [61](61-self-building-evals.md).
- **Bounding the loop in production:** [65](65-loop-contract.md) ·
  [67](67-hitl-approvals.md) (HITL approvals if you want a human gate on
  *paper* trades too).

## Pointers to source

- **The paper broker (read it — it's the recipe):** [`starters/trader/mcp/paper-broker.ts`](../starters/trader/mcp/paper-broker.ts).
- **Thredz backend + wiki tools:** [`packages/memory-service`](https://github.com/crewhaus/factory/tree/main/packages/memory-service), [`packages/tool-wiki`](https://github.com/crewhaus/factory/tree/main/packages/tool-wiki).
- **Heartbeat/schedule/SendMessage codegen:** [`packages/target-channel-bot`](https://github.com/crewhaus/factory/tree/main/packages/target-channel-bot).
- **MCP host (spawns the broker):** [`packages/mcp-host`](https://github.com/crewhaus/factory/tree/main/packages/mcp-host).
- **Thredz API:** [thredz.crewhaus.ai](https://thredz.crewhaus.ai).
