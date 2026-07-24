# Curriculum — systematic retail trading under real costs

This is the advisor's **learning plan**: what to learn, in a defensible
order, and where the trustworthy sources are. `/study` reads this to decide
what to learn next when there are no higher-priority knowledge gaps.
`/reflect` **edits** it — ticking mastered rungs and adding rungs for gaps
the advisor keeps hitting.

> Priority order for any study pass:
> 1. Open **knowledge gaps** logged via `log_knowledge_gap` — including
>    every exam question failed and every broker rejection that surprised
>    the advisor. Always first.
> 2. The next unchecked rung on the **ladder** below.
> 3. **What's new** — recent, high-quality developments (§ Frontier),
>    weighted below the time-tested fundamentals.

A rung is "mastered" when there's a `verified: true` wiki article that
covers it AND the exam has a passing question for it. Tick it then — not
before.

---

## Ladder (learn top-to-bottom)

### Tier 1 — The cost stack & market plumbing (learn FIRST; it gates everything)
- [ ] The full retail cost stack: $0 commissions vs what you still pay —
      bid-ask half-spread, slippage, SEC §31 fee (sells), FINRA TAF
      (sells); current rates and effective dates (see
      sources/costs-and-constraints.md, then verify against sec.gov/finra.org)
- [ ] Spread by liquidity tier: mega-cap ETFs (≤1 bp) → small caps
      (20–100 bp); why spreads widen at the open/close and after hours
- [ ] Order types and honest fill assumptions: market vs limit, fills at
      the ask not the mid, gaps through stops fill at the open
- [ ] Settlement: T+1, settled vs unsettled cash, good-faith violations,
      cash vs margin accounts; the 2026 retirement of the PDT rule
- [ ] Crypto venue mechanics: maker/taker tiers, spread markup on
      "simple buy" flows, 24/7 clock
- [ ] Net expectancy: expectancy, R-multiples, win rate vs payoff ratio,
      profit factor — and why cost drag turns marginal edges negative

### Tier 2 — Risk before strategy
- [ ] Position sizing: fixed-fractional risk (the 1% rail), risk of ruin,
      why sizing beats entry timing
- [ ] Drawdown math: loss → recovery asymmetry, high-water marks, why a
      drawdown halt exists
- [ ] Correlation and concentration: when five positions are one bet
- [ ] The wash-sale rule (61-day window) and what rapid iteration does to
      tax P&L vs mark-to-market P&L

### Tier 3 — Strategy families (what successful traders actually publish)
- [ ] Momentum & trend following: the published evidence, holding
      periods, cost sensitivity
- [ ] Mean reversion: where it works, why it fails in trends, stop
      placement difficulty
- [ ] Breakout / pullback structures: base patterns, failure modes
- [ ] Event-driven: earnings drift, index rebalances — capacity and
      crowding caveats
- [ ] What disclosed sources reveal and hide: 13F filings, investor
      letters, published backtests — survivorship and selection bias in
      "what successful traders do"

### Tier 4 — Validation (the difference between a backtest and an edge)
- [ ] Overfitting and multiple testing: why the 10th variant that finally
      "works" usually doesn't
- [ ] Lookahead and survivorship bias in data
- [ ] Walk-forward and out-of-sample discipline; regime dependence
- [ ] Sim-vs-real drift: what paper fills hide (queue position, partial
      fills, fast markets) and how to measure drift from operator-reported
      real fills

### Frontier (weighted below the fundamentals)
- [ ] Current market-structure changes (overnight sessions, settlement,
      fee schedule updates — rates reset yearly; re-verify effective dates)
- [ ] Recent peer-reviewed / SSRN work on retail-accessible anomalies

## Source notes

- Fee schedules and rules: sec.gov, finra.org, exchange schedules — always
  primary sources with effective dates; rates change yearly.
- Academic/practitioner: *.edu, ssrn.com, alphaarchitect.com,
  quantocracy.com (aggregator — follow through to the underlying paper).
- Local hand-checked notes live in sources/.
