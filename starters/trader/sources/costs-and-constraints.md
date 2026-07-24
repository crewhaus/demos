# Hand-checked seed note — the 2026 US retail cost stack

The advisor bootstraps from this note (and verifies it against primary
sources — rates carry effective dates and DO change). The paper broker's
defaults mirror these numbers; every one is env-tunable.

## Equities / ETFs

| Cost | 2026 value | Notes |
| ---- | ---------- | ----- |
| Commission | $0 | Universal at mainstream retail brokers (Schwab, Fidelity, E*TRADE, Robinhood, Webull) |
| SEC §31 fee | $20.60 per $1M sold | Sells only. Effective 2026-04-04; resets each fiscal year (was $27.80/M in 2024, $0 early FY2026) |
| FINRA TAF | $0.000195/share sold, cap $9.79/trade | Sells only. Effective 2026-01-01 (was $0.000166 / $8.30) |
| Half-spread | ~1–5 bps liquid large-cap; 5–20 bps mid-cap; 20–100 bps small-cap | You pay it each way. Widens 2–5× at open/close and in extended hours |
| Slippage | ≥ a few bps for marketable retail size | Sims systematically underestimate; fast markets are worse |

- **Settlement:** T+1 (since 2024-05-28). Cash accounts: buys need settled
  funds; selling a position bought with unsettled proceeds before they
  settle = good-faith violation → repeated GFVs bring a 90-day
  settled-funds-only restriction.
- **PDT:** abolished 2026-06-04 (FINRA Reg Notice 26-10) in favor of an
  intraday margin standard phasing in through 2027. Cash accounts were
  never PDT-bound; settled funds remain the binding constraint.
- **Hours (ET):** regular 9:30–16:00 Mon–Fri; broker pre/post 4:00–20:00;
  overnight 20:00–4:00 via ATS at some brokers, limit-only, thin books,
  much wider spreads. The paper broker fills equities in regular hours
  only.
- **Wash sale (IRC §1091):** a loss is disallowed if you buy substantially
  identical securities within 30 days before/after the sale (61-day
  window); the loss defers into the replacement basis. Rapid re-entry on
  the same symbols makes tax P&L diverge from mark-to-market P&L.

## Crypto

| Venue | Base-tier fees (side) | Notes |
| ----- | --------------------- | ----- |
| Coinbase Advanced | 0.40% maker / 0.60% taker | <$10k 30-day volume; tiers fall with volume |
| Kraken Pro | 0.25% maker / 0.40% taker | Since 2026-07-09 tier = max(volume, assets on platform) |
| "Simple buy" retail flows | ~0.5% spread markup + flat fee | Worst way to trade; avoid in any cost model |

Book spread on BTC/ETH at major venues: ~1–5 bps; long-tail alts 10–100+
bps. 24/7 clock, immediate settlement, no PDT/GFV — fees are the story.

## Options & futures (not modeled by the paper broker; extension targets)

- Options: $0.65/contract at Schwab/Fidelity/E*TRADE ($0 at Robinhood) +
  OCC clearing $0.025 + per-exchange ORF ($0.003–$0.022/contract after the
  2026-07-01 restructuring) + TAF $0.00329/contract on sells + SEC fee on
  sold premium.
- CME micros (MES/MNQ): ~$0.65–$0.95 all-in per side at discount futures
  brokers (exchange $0.37 + NFA/clearing $0.19 + commission); MES tick =
  $1.25, so fees + 1-tick spread ≈ $2.75 round turn — brutal for scalps.

## Paper-trading realism pitfalls (why the broker is strict)

1. Market orders fill at the ask/bid (± half-spread), never at last/mid.
2. Limit fills require trade-through, not a touch.
3. Stops gap: a stop through an overnight gap fills at the open.
4. Partial fills and latency exist; sims underestimate slippage.
5. Costs compound: the edge of most short-horizon retail strategies is
   smaller than half-spread + fees.

## Sources

- SEC Section 31 fee rate notices (sec.gov) — FY2026 rate effective
  2026-04-04.
- FINRA TAF schedule (finra.org) — rates effective 2026-01-01; PDT
  retirement per FINRA Regulatory Notice 26-10 (effective 2026-06-04).
- Broker fee schedules: Schwab, Fidelity, E*TRADE, Robinhood, Webull;
  Coinbase Advanced and Kraken Pro fee pages (2026-07).
- Morningstar ETF spread medians (2025-09); CME fee schedules; NinjaTrader
  futures commission schedule (2025-11).
