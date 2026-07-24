#!/usr/bin/env bun
/**
 * paper-broker — a zero-dependency stdio MCP server that is the trading
 * advisor's REFEREE: a simulated brokerage that fills paper orders at real
 * (delayed) market prices, charges every fee a US retail account actually
 * pays, enforces the constraints a real cash account actually has, and keeps
 * the score. The agent proposes trades; THIS process decides what they cost
 * and what they earned. The agent can never grade its own homework.
 *
 * Why it exists (the recipe's core idea): a brand-new harness has no eval
 * dataset and no graders. But a trading thesis has an OBJECTIVE, delayed
 * ground truth — realized P&L after costs. Every closed paper trade is a
 * scored sample. `export_dataset` turns the trade journal into an eval
 * dataset mechanically: winners become gold samples, losers become mutation
 * hints with the loss preserved as metadata — the same gold/hint split
 * `crewhaus distill` uses for human ratings.
 *
 * Market data (free, delayed — good enough to LEARN, never to front-run):
 *   • US equities/ETFs — Yahoo Finance v8 chart endpoint (no key; needs a
 *     browser User-Agent; polite cadence or you meet HTTP 429).
 *   • Crypto — Coinbase spot price API (`BTC-USD`).
 * A quote failure degrades the tool call with a clear error; it never
 * invents a price. Quotes are timestamped and staleness is reported.
 *
 * The cost model a US retail account actually pays (2026; see the recipe's
 * fee table for sources — every number is env-tunable):
 *   equities  commission $0 · SEC section 31 fee on SELLS ($20.60 per $1M
 *             notional, FY2026 rate effective 2026-04-04 — resets yearly)
 *             · FINRA TAF on SELLS ($0.000195/share, capped $9.79/trade,
 *             effective 2026-01-01)
 *             · half-spread + slippage in bps (you cross the spread twice;
 *             3 bps is fair for liquid large-caps, small-caps run 20-100)
 *   crypto    taker fee in bps (Coinbase Advanced base tier: 60 bps) +
 *             half-spread in bps
 * Fees are charged on EVERY fill, so expectancy here is net expectancy —
 * the only kind that survives contact with a real account.
 *
 * Notes on 2026 rules this sim reflects: the Pattern Day Trader $25k rule
 * was ABOLISHED 2026-06-04 (replaced by an intraday-margin standard), so
 * PDT is not modeled; this is a CASH account, where the binding constraint
 * is settled funds (good-faith violations) — enforced below. Wash sales
 * (IRC §1091, the 61-day window) are WARNED about on re-entry after a
 * loss, because they defer tax losses for rapid iterators.
 *
 * Constraints enforced in code (not just asked of the prompt):
 *   • CASH ACCOUNT: buys spend SETTLED cash only. Equity sale proceeds
 *     settle T+1 — spending unsettled proceeds (a good-faith violation at a
 *     real broker) is structurally impossible here.
 *   • MARKET HOURS: equity fills only 9:30–16:00 ET Mon–Fri (no holiday
 *     calendar — a documented simplification). Crypto fills 24/7.
 *   • RISK RAIL: every buy REQUIRES a stop price, and (entry − stop) × qty
 *     may not exceed RISK_PCT of account equity. No stop, no trade.
 *   • CONCENTRATION: one position ≤ MAX_POS_PCT of equity; no leverage —
 *     total exposure ≤ 100%. Long-only (shorting needs margin — see recipe).
 *   • DRAWDOWN HALT: equity below the high-water mark × (1 − HALT_PCT)
 *     blocks NEW buys until recovery. Losing streaks shrink, never spiral.
 *   • CONFIDENCE GATE: `performance` computes whether the advisor has
 *     EARNED the right to send the operator live trade alerts (min closed
 *     trades, positive net expectancy, profit factor, bounded drawdown).
 *     The gate lives here, in code — the prompt can't talk its way past it.
 *   • Paper and LIVE books never mix: `record_live_fill` logs the trades
 *     the human actually made in a separate ledger, so sim-vs-real drift is
 *     measurable instead of invisible.
 *
 * State lives under ./.paper-broker/ (atomic writes, append-only journal).
 * Config via env (Bun auto-loads ../.env):
 *   PAPER_SEED_USD          default 5000    opening simulated cash
 *   PAPER_HALF_SPREAD_BPS   default 3       equity half-spread cost, bps
 *   PAPER_SLIPPAGE_BPS      default 2       extra adverse fill drift, bps
 *   PAPER_CRYPTO_FEE_BPS    default 60      crypto taker fee, bps
 *   PAPER_CRYPTO_SPREAD_BPS default 10      crypto half-spread, bps
 *   PAPER_SEC_FEE_PER_M     default 20.60   SEC fee per $1M sold (equities)
 *   PAPER_TAF_PER_SHARE     default 0.000195  FINRA TAF per share sold
 *   PAPER_TAF_CAP           default 9.79    FINRA TAF cap per trade
 *   PAPER_RISK_PCT          default 0.01    max initial risk per trade
 *   PAPER_MAX_POS_PCT       default 0.20    max single-position exposure
 *   PAPER_HALT_PCT          default 0.15    drawdown that halts new buys
 *   CONFIDENCE_MIN_TRADES   default 40      closed trades before alerts
 *   CONFIDENCE_MIN_PF       default 1.3     min profit factor for alerts
 *   CONFIDENCE_MAX_DD       default 0.15    max drawdown for alerts
 *
 * stdout carries ONLY JSON-RPC frames. Diagnostics go to stderr.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

type Json = Record<string, unknown>;
const log = (...a: unknown[]) => process.stderr.write(`[paper-broker] ${a.join(" ")}\n`);

const DIR = join(process.cwd(), ".paper-broker");
const STATE = join(DIR, "state.json");
const JOURNAL = join(DIR, "trades.jsonl");
const LIVE = join(DIR, "live-fills.jsonl");
const DATASET_OUT = join(process.cwd(), "eval", "journal-dataset.jsonl");

function envNum(name: string, d: number): number {
  const n = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 ? n : d;
}
const SEED = envNum("PAPER_SEED_USD", 5000);
const HALF_SPREAD_BPS = envNum("PAPER_HALF_SPREAD_BPS", 3);
const SLIPPAGE_BPS = envNum("PAPER_SLIPPAGE_BPS", 2);
const CRYPTO_FEE_BPS = envNum("PAPER_CRYPTO_FEE_BPS", 60);
const CRYPTO_SPREAD_BPS = envNum("PAPER_CRYPTO_SPREAD_BPS", 10);
const SEC_FEE_PER_M = envNum("PAPER_SEC_FEE_PER_M", 20.6);
const TAF_PER_SHARE = envNum("PAPER_TAF_PER_SHARE", 0.000195);
const TAF_CAP = envNum("PAPER_TAF_CAP", 9.79);
const RISK_PCT = envNum("PAPER_RISK_PCT", 0.01);
const MAX_POS_PCT = envNum("PAPER_MAX_POS_PCT", 0.2);
const HALT_PCT = envNum("PAPER_HALT_PCT", 0.15);
const MIN_TRADES = envNum("CONFIDENCE_MIN_TRADES", 40);
const MIN_PF = envNum("CONFIDENCE_MIN_PF", 1.3);
const MAX_DD = envNum("CONFIDENCE_MAX_DD", 0.15);

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

// ── Durable state ────────────────────────────────────────────────────────────
type Lot = { qty: number; price: number; ts: string; stop: number; tradeId: string };
type Position = {
  symbol: string;
  cls: "equity" | "crypto";
  lots: Lot[];
  lastMark?: number;
  lastMarkTs?: string;
};
type OpenTrade = {
  id: string;
  ts: string;
  symbol: string;
  cls: "equity" | "crypto";
  qty: number;
  entry: number; // fill price incl. spread+slippage
  fees: number; // entry-side fees
  stop: number;
  target?: number;
  horizonDays?: number;
  playbook: string;
  thesis: string;
  riskUsd: number; // (entry − stop) × qty at entry — the R denominator
};
type ClosedTrade = OpenTrade & {
  closedTs: string;
  exit: number; // fill price incl. spread+slippage
  exitFees: number;
  pnl: number; // net of ALL fees
  r: number; // pnl / riskUsd
  score: number; // clamp01(0.5 + r/4) — the sample score
  holdDays: number;
  exitReason: string;
};
type Settlement = { amount: number; settlesTs: string }; // pending T+1 proceeds
type State = {
  currency: "USD";
  seed: number;
  createdAt: string;
  cash: number; // total cash (settled + unsettled)
  unsettled: Settlement[];
  positions: Record<string, Position>;
  open: OpenTrade[];
  closedCount: number;
  realizedPnl: number;
  feesPaid: number;
  highWater: number; // equity high-water mark
  seq: number;
};

let state: State;

function freshState(): State {
  return {
    currency: "USD",
    seed: SEED,
    createdAt: new Date().toISOString(),
    cash: SEED,
    unsettled: [],
    positions: {},
    open: [],
    closedCount: 0,
    realizedPnl: 0,
    feesPaid: 0,
    highWater: SEED,
    seq: 0,
  };
}
function loadState(): State {
  if (!existsSync(STATE)) return freshState();
  try {
    const s = JSON.parse(readFileSync(STATE, "utf8")) as State;
    if (typeof s.cash !== "number" || !s.positions) throw new Error("shape");
    return s;
  } catch (err) {
    log(`state file corrupt (${(err as Error).message}) — starting fresh (journal is preserved)`);
    return freshState();
  }
}
function persist() {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE);
}
function journal(entry: Json) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  appendFileSync(JOURNAL, `${JSON.stringify(entry)}\n`);
}

// ── Market data (free, delayed) ──────────────────────────────────────────────
type Quote = { symbol: string; cls: "equity" | "crypto"; price: number; asof: string; stale: boolean };
const CRYPTO_RE = /^[A-Z0-9]{2,10}-USD$/;
const EQUITY_RE = /^[A-Z.]{1,6}$/;

function classify(raw: string): { symbol: string; cls: "equity" | "crypto" } | null {
  const s = raw.trim().toUpperCase();
  if (CRYPTO_RE.test(s)) return { symbol: s, cls: "crypto" };
  if (EQUITY_RE.test(s)) return { symbol: s, cls: "equity" };
  return null;
}

async function fetchQuote(raw: string): Promise<Quote | { error: string }> {
  const c = classify(raw);
  if (!c) return { error: `Unrecognized symbol '${raw}'. Equities: 'AAPL'. Crypto: 'BTC-USD'.` };
  try {
    if (c.cls === "crypto") {
      const res = await fetch(`https://api.coinbase.com/v2/prices/${c.symbol}/spot`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { error: `Coinbase quote for ${c.symbol} failed: HTTP ${res.status}` };
      const body = (await res.json()) as { data?: { amount?: string } };
      const price = Number.parseFloat(body.data?.amount ?? "");
      if (!Number.isFinite(price) || price <= 0) return { error: `Coinbase returned no price for ${c.symbol}` };
      return { symbol: c.symbol, cls: "crypto", price, asof: new Date().toISOString(), stale: false };
    }
    const ysym = c.symbol.replace(/\./g, "-"); // BRK.B → BRK-B
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ysym}?interval=1d&range=1d`, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) return { error: `Quote source rate-limited (HTTP 429) for ${c.symbol} — slow the polling cadence and retry later. Never guess a price instead.` };
    if (!res.ok) return { error: `Quote for ${c.symbol} failed: HTTP ${res.status}` };
    const body = (await res.json()) as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; regularMarketTime?: number } }>; error?: { description?: string } } };
    const meta = body.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (!Number.isFinite(price) || (price as number) <= 0) {
      return { error: `No price for ${c.symbol} — unknown ticker? (${body.chart?.error?.description ?? "no data"})` };
    }
    const asofMs = (meta?.regularMarketTime ?? 0) * 1000;
    const asof = asofMs ? new Date(asofMs).toISOString() : new Date().toISOString();
    return { symbol: c.symbol, cls: "equity", price: price as number, asof, stale: asofMs > 0 && Date.now() - asofMs > 26 * 3600 * 1000 };
  } catch (err) {
    return { error: `Quote fetch for ${c.symbol} threw: ${(err as Error).message}` };
  }
}

// ── Market hours (ET) ────────────────────────────────────────────────────────
function etParts(): { dow: number; minutes: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: dows[parts.weekday as string] ?? 0, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
function equityMarketOpen(): boolean {
  const { dow, minutes } = etParts();
  return dow >= 1 && dow <= 5 && minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

// ── Fees & fills ─────────────────────────────────────────────────────────────
function entryFill(cls: "equity" | "crypto", price: number, qty: number) {
  const spread = cls === "equity" ? HALF_SPREAD_BPS : CRYPTO_SPREAD_BPS;
  const fill = price * (1 + (spread + SLIPPAGE_BPS) / 10000);
  const fees = cls === "crypto" ? (fill * qty * CRYPTO_FEE_BPS) / 10000 : 0; // equity buys: $0 commission, no SEC/TAF
  return { fill: round4(fill), fees: round2(fees) };
}
function exitFill(cls: "equity" | "crypto", price: number, qty: number) {
  const spread = cls === "equity" ? HALF_SPREAD_BPS : CRYPTO_SPREAD_BPS;
  const fill = price * (1 - (spread + SLIPPAGE_BPS) / 10000);
  let fees = 0;
  if (cls === "equity") {
    const notional = fill * qty;
    fees += (notional / 1_000_000) * SEC_FEE_PER_M; // SEC section 31 (sells)
    fees += Math.min(qty * TAF_PER_SHARE, TAF_CAP); // FINRA TAF (sells)
  } else {
    fees += (fill * qty * CRYPTO_FEE_BPS) / 10000;
  }
  return { fill: round4(fill), fees: round2(fees) };
}

// ── Accounting ───────────────────────────────────────────────────────────────
function settleDue() {
  const now = Date.now();
  const still: Settlement[] = [];
  for (const s of state.unsettled) {
    if (Date.parse(s.settlesTs) > now) still.push(s);
  }
  state.unsettled = still;
}
function settledCash(): number {
  settleDue();
  const pending = state.unsettled.reduce((a, s) => a + s.amount, 0);
  return round2(state.cash - pending);
}
function positionValue(): number {
  let v = 0;
  for (const p of Object.values(state.positions)) {
    const mark = p.lastMark ?? p.lots[0]?.price ?? 0;
    v += mark * p.lots.reduce((a, l) => a + l.qty, 0);
  }
  return v;
}
function equity(): number {
  return round2(state.cash + positionValue());
}
function drawdown(): number {
  const hw = Math.max(state.highWater, 1e-9);
  return round4(Math.max(0, (hw - equity()) / hw));
}
function touchHighWater() {
  if (equity() > state.highWater) state.highWater = equity();
}
function nextTradeSettlement(cls: "equity" | "crypto", amount: number) {
  if (cls === "crypto") return; // crypto settles immediately
  // T+1: next business day, 16:00 ET approximated as +1 day (+3 over Fri/Sat)
  const { dow } = etParts();
  const days = dow === 5 ? 3 : dow === 6 ? 2 : 1;
  state.unsettled.push({ amount: round2(amount), settlesTs: new Date(Date.now() + days * 86400000).toISOString() });
}

// ── Closed-trade scoring ─────────────────────────────────────────────────────
function readClosed(): ClosedTrade[] {
  if (!existsSync(JOURNAL)) return [];
  const out: ClosedTrade[] = [];
  for (const line of readFileSync(JOURNAL, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as Json;
      if (e.event === "close") out.push(e.trade as ClosedTrade);
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}
function perfStats(trades: ClosedTrade[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pnl = round2(grossWin - grossLoss);
  const fees = round2(trades.reduce((a, t) => a + t.fees + t.exitFees, 0));
  const notionalTraded = trades.reduce((a, t) => a + (t.entry + t.exit) * t.qty, 0);
  return {
    trades: n,
    winRate: n ? round4(wins.length / n) : 0,
    expectancyUsd: n ? round2(pnl / n) : 0,
    avgR: n ? round4(trades.reduce((a, t) => a + t.r, 0) / n) : 0,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : wins.length ? 999 : 0, // 999 = no losses yet (Infinity won't JSON)
    netPnl: pnl,
    feesPaid: fees,
    feeDragBps: notionalTraded > 0 ? round2((fees / notionalTraded) * 10000) : 0,
  };
}

// ── Tool handlers ────────────────────────────────────────────────────────────
type ToolResult = { text: string; isError?: boolean };
const ok = (obj: Json): ToolResult => ({ text: JSON.stringify(obj, null, 2) });
const fail = (msg: string): ToolResult => ({ text: msg, isError: true });

const handlers: Record<string, (args: Json) => Promise<ToolResult> | ToolResult> = {
  async quote(args) {
    const q = await fetchQuote(String(args.symbol ?? ""));
    if ("error" in q) return fail(q.error);
    return ok({ ...q, note: q.stale ? "STALE quote (>26h — weekend/holiday?). Trade sizing only; do not treat as current." : "delayed quote — fine for learning, useless for front-running" });
  },

  account() {
    settleDue();
    return ok({
      mode: "paper",
      cash: round2(state.cash),
      settledCash: settledCash(),
      unsettled: state.unsettled,
      equity: equity(),
      highWater: round2(state.highWater),
      drawdown: drawdown(),
      halted: drawdown() >= HALT_PCT,
      positions: Object.values(state.positions).map((p) => ({
        symbol: p.symbol,
        qty: p.lots.reduce((a, l) => a + l.qty, 0),
        avgCost: round4(p.lots.reduce((a, l) => a + l.qty * l.price, 0) / Math.max(1e-9, p.lots.reduce((a, l) => a + l.qty, 0))),
        lastMark: p.lastMark,
        lastMarkTs: p.lastMarkTs,
      })),
      openTrades: state.open.length,
      closedTrades: state.closedCount,
      realizedPnl: round2(state.realizedPnl),
      feesPaid: round2(state.feesPaid),
    });
  },

  async paper_buy(args) {
    const symbol = String(args.symbol ?? "");
    const thesis = String(args.thesis ?? "").trim();
    const playbook = String(args.playbook ?? "").trim();
    const stop = Number(args.stop);
    const target = args.target === undefined ? undefined : Number(args.target);
    const horizonDays = args.horizon_days === undefined ? undefined : Number(args.horizon_days);
    if (thesis.length < 40) return fail("REJECTED: thesis must state the setup, the edge, and the exit plan (≥40 chars). The journal is the dataset — a trade without a thesis is an unlabeled sample.");
    if (!playbook) return fail("REJECTED: playbook is required (e.g. 'breakout-pullback'). Performance is tracked per playbook.");
    if (!Number.isFinite(stop) || stop <= 0) return fail("REJECTED: a stop price is required. No stop, no trade — the risk rail needs the R denominator.");

    const q = await fetchQuote(symbol);
    if ("error" in q) return fail(q.error);
    if (q.cls === "equity" && !equityMarketOpen()) return fail("REJECTED: US equity market is closed (fills 9:30–16:00 ET Mon–Fri). Queue the idea in the journal and act at the open — or trade crypto, which fills 24/7.");
    if (drawdown() >= HALT_PCT) return fail(`REJECTED: drawdown halt — equity is ${(drawdown() * 100).toFixed(1)}% below the high-water mark (halt at ${(HALT_PCT * 100).toFixed(0)}%). Close or study; no new buys until recovery.`);

    let qty = Number(args.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      const notional = Number(args.notional);
      if (!Number.isFinite(notional) || notional <= 0) return fail("REJECTED: pass qty or notional (USD).");
      // Floor (never round) so the position can't exceed the requested notional.
      qty = q.cls === "crypto" ? Math.floor((notional / q.price) * 1e4) / 1e4 : Math.floor(notional / q.price);
      if (qty <= 0) return fail("REJECTED: notional too small for one share.");
    }

    const { fill, fees } = entryFill(q.cls, q.price, qty);
    if (stop >= fill) return fail(`REJECTED: stop (${stop}) must be BELOW the expected fill (${fill}) for a long. This account is long-only (shorting needs margin — see the recipe).`);
    const cost = round2(fill * qty + fees);
    const sc = settledCash();
    if (cost > sc) return fail(`REJECTED: costs $${cost} but settled cash is $${sc} (total cash $${round2(state.cash)} — $${round2(state.cash - sc)} is T+1 unsettled proceeds; spending it would be a good-faith violation at a real broker).`);

    const eq = equity();
    const riskUsd = round2((fill - stop) * qty);
    if (riskUsd > eq * RISK_PCT) return fail(`REJECTED: initial risk $${riskUsd} exceeds the ${(RISK_PCT * 100).toFixed(1)}% risk rail ($${round2(eq * RISK_PCT)} on $${eq} equity). Shrink qty or tighten the stop.`);
    // Concentration cap is per POSITION (existing lots included), not per order.
    const existingQty = (state.positions[q.symbol]?.lots ?? []).reduce((a, l) => a + l.qty, 0);
    const positionValueAfter = round2((existingQty + qty) * fill);
    if (positionValueAfter > eq * MAX_POS_PCT) return fail(`REJECTED: ${q.symbol} position would be $${positionValueAfter} (incl. ${existingQty} already held), exceeding the ${(MAX_POS_PCT * 100).toFixed(0)}% concentration cap ($${round2(eq * MAX_POS_PCT)}).`);

    state.seq += 1;
    const id = `t${String(state.seq).padStart(5, "0")}`;
    const ts = new Date().toISOString();
    state.cash = round2(state.cash - cost);
    const pos = (state.positions[q.symbol] ??= { symbol: q.symbol, cls: q.cls, lots: [] });
    pos.lots.push({ qty, price: fill, ts, stop, tradeId: id });
    pos.lastMark = q.price;
    pos.lastMarkTs = q.asof;
    const trade: OpenTrade = { id, ts, symbol: q.symbol, cls: q.cls, qty, entry: fill, fees, stop, target, horizonDays, playbook, thesis, riskUsd };
    state.open.push(trade);
    state.feesPaid = round2(state.feesPaid + fees);
    persist();
    journal({ event: "open", ts, trade });
    // Wash-sale heads-up (IRC §1091): re-buying within 30 days of a realized
    // loss on the same symbol would defer that tax loss in a real account.
    const cutoff = Date.now() - 30 * 86400000;
    const washSale = q.cls === "equity" && readClosed().some((t) => t.symbol === q.symbol && t.pnl < 0 && Date.parse(t.closedTs) >= cutoff);
    return ok({ filled: true, id, symbol: q.symbol, qty, fill, fees, cost, quoteAsof: q.asof, stale: q.stale, riskUsd, ...(washSale ? { washSaleWarning: `You realized a loss on ${q.symbol} within the last 30 days — in a real account this repurchase would DEFER that tax loss (wash sale, 61-day window). Simulated P&L is unaffected; your tax P&L would not be.` } : {}), note: "Paper fill at delayed price + spread + slippage. Log the outcome honestly when you close." });
  },

  async paper_sell(args) {
    const symbol = String(args.symbol ?? "").toUpperCase();
    const reason = String(args.reason ?? "").trim();
    if (!reason) return fail("REJECTED: reason is required (stop hit / target hit / thesis invalidated / time stop / rebalance). Exit reasons are how the advisor learns WHICH exits it gets wrong.");
    const pos = state.positions[symbol];
    if (!pos || pos.lots.length === 0) return fail(`No position in ${symbol}.`);
    if (pos.cls === "equity" && !equityMarketOpen()) return fail("REJECTED: US equity market is closed (fills 9:30–16:00 ET Mon–Fri).");

    const q = await fetchQuote(symbol);
    if ("error" in q) return fail(q.error);
    const held = pos.lots.reduce((a, l) => a + l.qty, 0);
    let qty = Number(args.qty);
    if (!Number.isFinite(qty) || qty <= 0) qty = held;
    if (qty > held) return fail(`REJECTED: you hold ${held} ${symbol}, cannot sell ${qty}.`);

    const { fill, fees } = exitFill(pos.cls, q.price, qty);
    const ts = new Date().toISOString();
    let remaining = qty;
    const closed: ClosedTrade[] = [];
    while (remaining > 1e-9 && pos.lots.length) {
      const lot = pos.lots[0];
      const take = Math.min(lot.qty, remaining);
      const openTrade = state.open.find((t) => t.id === lot.tradeId);
      const feeShare = round2((fees * take) / qty);
      // Prorate the REMAINING entry fees and consume them, so multi-tranche
      // closes never double-charge the entry side.
      const entryFeeShare = openTrade ? round2((openTrade.fees * take) / openTrade.qty) : 0;
      const pnl = round2((fill - lot.price) * take - feeShare - entryFeeShare);
      if (openTrade) {
        const closingWhole = take >= lot.qty - 1e-9 && Math.abs(openTrade.qty - lot.qty) < 1e-9;
        const riskShare = round2(openTrade.riskUsd * (take / openTrade.qty)) || 0.01;
        const r = round4(pnl / Math.max(0.01, riskShare));
        const rec: ClosedTrade = {
          ...openTrade,
          qty: take,
          fees: entryFeeShare, // this tranche's entry-fee share, not the trade's full entry fees
          closedTs: ts,
          exit: fill,
          exitFees: feeShare,
          pnl,
          r,
          score: round4(clamp01(0.5 + r / 4)),
          holdDays: round2((Date.parse(ts) - Date.parse(openTrade.ts)) / 86400000),
          exitReason: reason,
        };
        closed.push(rec);
        if (closingWhole) state.open = state.open.filter((t) => t.id !== openTrade.id);
        else {
          openTrade.qty = round4(openTrade.qty - take);
          openTrade.riskUsd = round2(openTrade.riskUsd - riskShare);
          openTrade.fees = round2(openTrade.fees - entryFeeShare);
        }
      }
      lot.qty = round4(lot.qty - take);
      remaining -= take;
      if (lot.qty <= 1e-9) pos.lots.shift();
    }
    if (pos.lots.length === 0) delete state.positions[symbol];

    const proceeds = round2(fill * qty - fees);
    state.cash = round2(state.cash + proceeds);
    nextTradeSettlement(pos.cls, proceeds);
    const pnlTotal = round2(closed.reduce((a, t) => a + t.pnl, 0));
    state.realizedPnl = round2(state.realizedPnl + pnlTotal);
    state.feesPaid = round2(state.feesPaid + fees);
    state.closedCount += closed.length;
    touchHighWater();
    persist();
    for (const trade of closed) journal({ event: "close", ts, trade });
    return ok({ filled: true, symbol, qty, fill, fees, proceeds, settlement: pos.cls === "equity" ? "T+1 (unsettled until then)" : "immediate", closed: closed.map((t) => ({ id: t.id, pnl: t.pnl, r: t.r, score: t.score, playbook: t.playbook, exitReason: t.exitReason })), realizedPnlTotal: round2(state.realizedPnl) });
  },

  async mark_to_market() {
    const marks: Json[] = [];
    for (const p of Object.values(state.positions)) {
      const q = await fetchQuote(p.symbol);
      if ("error" in q) {
        marks.push({ symbol: p.symbol, error: q.error });
        continue;
      }
      p.lastMark = q.price;
      p.lastMarkTs = q.asof;
      const qty = p.lots.reduce((a, l) => a + l.qty, 0);
      const cost = p.lots.reduce((a, l) => a + l.qty * l.price, 0);
      marks.push({ symbol: p.symbol, qty, avgCost: round4(cost / Math.max(qty, 1e-9)), mark: q.price, stale: q.stale, unrealized: round2(qty * q.price - cost), stopBreached: p.lots.some((l) => q.price <= l.stop) });
    }
    touchHighWater();
    persist();
    return ok({ equity: equity(), drawdown: drawdown(), halted: drawdown() >= HALT_PCT, marks, note: "stopBreached: true means the stop plan says EXIT — honor your own stops or the journal will grade you for ignoring them." });
  },

  journal_read(args) {
    const limit = Math.min(Math.max(1, Number(args.limit) || 20), 200);
    const playbook = args.playbook ? String(args.playbook) : undefined;
    const closed = readClosed().filter((t) => !playbook || t.playbook === playbook);
    const openList = state.open.filter((t) => !playbook || t.playbook === playbook);
    return ok({
      open: openList.map((t) => ({ id: t.id, ts: t.ts, symbol: t.symbol, qty: t.qty, entry: t.entry, stop: t.stop, target: t.target, playbook: t.playbook, thesis: t.thesis })),
      closed: closed.slice(-limit).reverse().map((t) => ({ id: t.id, ts: t.ts, closedTs: t.closedTs, symbol: t.symbol, playbook: t.playbook, pnl: t.pnl, r: t.r, score: t.score, holdDays: t.holdDays, exitReason: t.exitReason, thesis: t.thesis })),
    });
  },

  performance(args) {
    const playbook = args.playbook ? String(args.playbook) : undefined;
    const all = readClosed();
    const trades = all.filter((t) => !playbook || t.playbook === playbook);
    const stats = perfStats(trades);
    const dd = drawdown();
    const perPlaybook: Json = {};
    for (const t of all) {
      (perPlaybook[t.playbook] ??= []) as ClosedTrade[];
      (perPlaybook[t.playbook] as ClosedTrade[]).push(t);
    }
    const playbooks = Object.fromEntries(Object.entries(perPlaybook).map(([k, v]) => [k, perfStats(v as ClosedTrade[])]));
    // Count independent DECISIONS (distinct trade ids), not exit tranches —
    // scaling out of 10 positions in 4 pieces each is 10 trades, not 40.
    const distinctTrades = new Set(trades.map((t) => t.id)).size;
    const checks = {
      enough_trades: { pass: distinctTrades >= MIN_TRADES, have: distinctTrades, need: MIN_TRADES },
      positive_expectancy_after_fees: { pass: stats.expectancyUsd > 0, have: stats.expectancyUsd },
      profit_factor: { pass: stats.profitFactor >= MIN_PF, have: stats.profitFactor, need: MIN_PF },
      drawdown_bounded: { pass: dd <= MAX_DD, have: dd, need: MAX_DD },
    };
    const alertsUnlocked = Object.values(checks).every((c) => c.pass);
    return ok({
      scope: playbook ?? "all",
      ...stats,
      currentDrawdown: dd,
      playbooks,
      confidenceGate: { alertsUnlocked, checks, note: alertsUnlocked ? "Gate PASSED — the advisor has earned the right to send live trade alerts. Keep validating; the gate re-evaluates on every call." : "Gate NOT passed — keep paper trading and studying. Do NOT send the operator live trade alerts." },
    });
  },

  export_dataset(args) {
    const minScore = Number.isFinite(Number(args.min_score)) ? Number(args.min_score) : 0.5;
    const closed = readClosed();
    if (!closed.length) return fail("No closed trades yet — the dataset is earned, not written. Paper trade first.");
    // Partial closes journal multiple tranches under one trade id; eval
    // sample ids must be unique, so later tranches get a .N suffix.
    const seen = new Map<string, number>();
    const lines = closed.map((t) => {
      const n = (seen.get(t.id) ?? 0) + 1;
      seen.set(t.id, n);
      const base = {
        id: n === 1 ? t.id : `${t.id}.${n}`,
        input: `Market setup (${t.symbol}, playbook: ${t.playbook}):\n${t.thesis}\nEvaluate this setup: state whether to take the trade, the entry, stop, target, position size under a 1% risk rail, and the expected costs.`,
        metadata: { playbook: t.playbook, symbol: t.symbol, r: t.r, pnl: t.pnl, score: t.score, holdDays: t.holdDays, exitReason: t.exitReason, role: t.score >= minScore ? "gold" : "hint" },
      };
      return t.score >= minScore
        ? { ...base, expected_output: `TAKE. ${t.thesis} Entry ~${t.entry}, stop ${t.stop}${t.target ? `, target ${t.target}` : ""}. Realized ${t.r}R after all fees.` }
        : base; // low-scoring trades: input + metadata only — mutation hints, never asserted as gold
    });
    mkdirSync(join(process.cwd(), "eval"), { recursive: true });
    writeFileSync(DATASET_OUT, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const golds = lines.filter((l) => "expected_output" in l).length;
    return ok({ wrote: DATASET_OUT, samples: lines.length, golds, hints: lines.length - golds, note: "Winners are golds (their theses are proven exemplars); losers are hints (input + failure metadata, never asserted as correct). Same split crewhaus distill uses for ratings." });
  },

  record_live_fill(args) {
    const symbol = String(args.symbol ?? "").toUpperCase();
    const side = String(args.side ?? "").toLowerCase();
    const qty = Number(args.qty);
    const price = Number(args.price);
    if (!symbol || (side !== "buy" && side !== "sell") || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price <= 0) {
      return fail("record_live_fill needs symbol, side (buy|sell), qty, price. Optional: fees, note, paper_trade_id (the paper trade this mirrors).");
    }
    const entry = { ts: new Date().toISOString(), symbol, side, qty, price, fees: Number(args.fees) || 0, note: args.note ? String(args.note) : undefined, paperTradeId: args.paper_trade_id ? String(args.paper_trade_id) : undefined };
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    appendFileSync(LIVE, `${JSON.stringify(entry)}\n`);
    return ok({ recorded: entry, note: "Live fills live in a SEPARATE ledger — they never touch paper cash. Compare against the mirrored paper trade to measure sim-vs-real drift (fills, fees, your own execution delay)." });
  },

  live_book() {
    if (!existsSync(LIVE)) return ok({ fills: [], note: "No live fills recorded yet." });
    const fills = readFileSync(LIVE, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return ok({ fills: fills.slice(-100) });
  },
};

// ── Tool schemas ─────────────────────────────────────────────────────────────
const s = (props: Json, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (d: string) => ({ type: "string", description: d });
const nm = (d: string) => ({ type: "number", description: d });

const TOOLS = [
  { name: "quote", description: "Delayed quote for a US equity/ETF ('AAPL') or crypto pair ('BTC-USD'). Reports the as-of time and staleness. Never invents a price.", inputSchema: s({ symbol: str("ticker, e.g. AAPL or BTC-USD") }, ["symbol"]) },
  { name: "account", description: "Paper account snapshot: cash vs SETTLED cash (T+1), equity, positions, drawdown vs high-water, and whether the drawdown halt is active.", inputSchema: s({}) },
  { name: "paper_buy", description: "Simulated LONG fill at the delayed price + half-spread + slippage, with all real fees. REQUIRES a thesis (≥40 chars), a playbook tag, and a stop. Enforces settled-cash, market hours, the 1% risk rail, the concentration cap, and the drawdown halt. Rejections explain themselves — read them, they are the constraint you'd hit at a real broker.", inputSchema: s({ symbol: str("ticker"), qty: nm("shares/units (or pass notional)"), notional: nm("USD to deploy (alternative to qty)"), thesis: str("the setup, the edge, and the exit plan — this becomes the eval sample's input"), playbook: str("strategy tag, e.g. breakout-pullback"), stop: nm("stop price (required — the R denominator)"), target: nm("optional target price"), horizon_days: nm("optional expected hold, days") }, ["symbol", "thesis", "playbook", "stop"]) },
  { name: "paper_sell", description: "Simulated sell (FIFO lots) at the delayed price − half-spread − slippage, minus SEC/TAF (equities) or taker fee (crypto). Realizes P&L, computes the R-multiple and a [0,1] score per closed trade, appends them to the journal. Requires an exit reason.", inputSchema: s({ symbol: str("ticker"), qty: nm("how much (default: whole position)"), reason: str("stop hit | target hit | thesis invalidated | time stop | rebalance") }, ["symbol", "reason"]) },
  { name: "mark_to_market", description: "Refresh quotes on all open positions: unrealized P&L, drawdown, halt status, and whether any stop plan is breached. Call at every heartbeat tick.", inputSchema: s({}) },
  { name: "journal_read", description: "The trade journal: open theses and closed trades with P&L, R, score, hold time, exit reason — optionally filtered by playbook. This journal IS the future eval dataset.", inputSchema: s({ limit: nm("closed trades to return (default 20, max 200)"), playbook: str("filter by playbook tag") }) },
  { name: "performance", description: "The referee's report: win rate, net expectancy AFTER fees, profit factor, fee drag, per-playbook breakdown — and the CONFIDENCE GATE verdict (alertsUnlocked) computed in code from min-trades/expectancy/profit-factor/drawdown thresholds. The prompt cannot override this verdict.", inputSchema: s({ playbook: str("scope to one playbook") }) },
  { name: "export_dataset", description: "Write eval/journal-dataset.jsonl from the closed-trade journal: score ≥ min_score → gold sample (thesis as proven exemplar), below → mutation hint (input + failure metadata, no asserted answer). The mechanical bridge from performance to eval assets.", inputSchema: s({ min_score: nm("gold threshold in [0,1] (default 0.5 — i.e. positive R)") }) },
  { name: "record_live_fill", description: "Log a REAL trade the operator reports having made (never executes anything). Kept in a separate live ledger for sim-vs-real drift analysis.", inputSchema: s({ symbol: str("ticker"), side: str("buy | sell"), qty: nm("filled quantity"), price: nm("actual fill price"), fees: nm("actual fees paid (optional)"), note: str("context, e.g. 'from alert t00042'"), paper_trade_id: str("the paper trade this mirrors (optional)") }, ["symbol", "side", "qty", "price"]) },
  { name: "live_book", description: "The operator's reported real fills (read-only).", inputSchema: s({}) },
];

// ── JSON-RPC / MCP wire loop ─────────────────────────────────────────────────
const SUPPORTED_PROTO = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const NEWEST_PROTO = "2025-06-18";

function send(msg: Json) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function reply(id: unknown, result: Json) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id: unknown, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(msg: Json): Promise<void> {
  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };
  if (method === undefined) return;
  const isNotification = id === undefined || id === null;
  switch (method) {
    case "initialize": {
      const req = params?.protocolVersion as string | undefined;
      const proto = req && SUPPORTED_PROTO.has(req) ? req : NEWEST_PROTO;
      reply(id, { protocolVersion: proto, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paper-broker", version: "0.1.0" } });
      return;
    }
    case "notifications/initialized":
      return;
    case "ping":
      if (!isNotification) reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      const name = params?.name as string;
      const args = (params?.arguments as Json) ?? {};
      const fn = handlers[name];
      if (!fn) {
        reply(id, { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true });
        return;
      }
      try {
        const out = await fn(args);
        reply(id, { content: [{ type: "text", text: out.text }], isError: out.isError ?? false });
      } catch (err) {
        reply(id, { content: [{ type: "text", text: `Tool ${name} threw: ${(err as Error).message}` }], isError: true });
      }
      return;
    }
    default:
      if (!isNotification) replyError(id, -32601, `Method not found: ${method}`);
      return;
  }
}

function main() {
  state = loadState();
  persist();
  log(`ready — mode=paper seed=$${state.seed} cash=$${round2(state.cash)} equity=$${equity()} closed=${state.closedCount}`);
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    for await (const chunk of Bun.stdin.stream()) {
      buf += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg: Json;
        try {
          msg = JSON.parse(line);
        } catch {
          log(`skip non-JSON line: ${line.slice(0, 80)}`);
          continue;
        }
        await handle(msg);
      }
    }
  })();
}

main();
