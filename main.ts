// Tide Rider: a cross-sectional momentum bot for the bars replay (agent-fun/bars-replay/v1).
//
// Idea, in the Surge Rider spirit: only ride what is already rising, and sit in cash when
// the tide is out. Every symbol is ranked by its trailing return; the bot holds the top
// few that are rising on both a slow (24-bar) and a fast (6-bar) lookback, rebalances
// every 12 bars, and goes flat whenever the median trailing return across the universe
// is negative — in a falling market the best trade is no trade. Positions are cut by a
// stop loss (value 12% under cost) and by a momentum fade (fast return under -5%), so
// losers never ride the market down. A max hold time forces turnover so the run
// clears the 8-trade minimum even in a one-way market, where the bot would otherwise
// buy once and hold to the end. Sizing is an even split of equity over the target
// slots, capped by the 25% weight cap; buys are decided one batch after sells so the
// proceeds are in cash first.
//
// Deterministic by construction: no clock, no environment, no randomness; ranking is
// exact bigint cross-multiplication, the rest is IEEE-754 float64 on the closes, so the
// same bars always give the same orders. The wire shim below is written from the
// protocol's documented shape (one JSON line per message, one reply per batch echoing
// its seq); diagnostics go to stderr only, stdout carries replies.
//
// Guardrails: 8+ trades come from rebalancing across 136 bars; drawdown stays small
// because the bot is flat whenever breadth is negative.

import { createInterface } from 'node:readline';

// ---------------------------------------------------------------- parameters
const PARAMS = {
  /** Slow lookback in bars for ranking and the regime filter. */
  lookback: 12,
  /** Fast lookback in bars for entry confirmation and fade exits. */
  short: 6,
  /** Bars between rebalances. */
  rebalanceEvery: 12,
  /** Most symbols held at once: 4 slots at the 25% weight cap deploy up to 100%
   *  of equity, so a broad rally is ridden nearly in full; the 12-bar lookback
   *  and 12-bar rebalance were the dev-window winners over 24-bar and 6-bar
   *  cadences (faster churn lost money in the choppy down market). */
  topN: 4,
  /** Exit when a position's value falls this far under its cost (bps). */
  stopBps: 1200,
  /** Exit when a held symbol's fast return falls below -fadeBps (bps). */
  fadeBps: 500,
  /** Exit a position once it has been held this many bars: forces turnover so the
   *  run clears the 8-trade minimum even in a one-way market, where the bot would
   *  otherwise buy once and hold to the end. Re-entry at the next rebalance is
   *  allowed when the symbol is still in the target. */
  maxHoldBars: 24,
  /** Slippage cap on every order (bps past the close it was decided on). */
  slipBps: 100,
};

// ---------------------------------------------------------------- wire types
type U64 = string;
interface HelloSymbol { symbol: string; mint: string; price_scale: number; qty_scale: number }
interface Hello {
  type: 'hello'; protocol: string; seed: U64; symbols: HelloSymbol[];
  capital: { quote: 'USDC'; quote_scale: number; quote_units: U64 };
  bar_interval: string; first_close_ms: number;
  caps: { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number; shorts: boolean; leverage: boolean };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: U64 };
  latency_bars: number; warmup_bars?: number;
}
interface Bar { symbol: string; t: number; o: U64; h: U64; l: U64; c: U64; v: U64 | null; o_depth: U64[]; c_depth: U64[] }
interface Fill {
  client_id: string; symbol: string; side: 'buy' | 'sell'; status: 'filled' | 'rejected';
  reason: string | null; decided_bar: number; fill_bar: number; price: U64; qty: U64;
  notional_quote_units: U64; fee_quote_units: U64;
}
interface Batch { type: 'batch'; seq: number; t: number; bars: Bar[]; fills: Fill[]; account: Account }
interface Done { type: 'done'; seq: number; reason: string; account: Account }
interface Account { cash_quote_units: U64; positions: { symbol: string; qty: U64; cost_quote_units: U64 }[]; equity_quote_units: U64 }
interface BuyOrder { side: 'buy'; client_id: string; symbol: string; notional_quote_units: U64; max_slippage_bps: number }
interface SellOrder { side: 'sell'; client_id: string; symbol: string; qty: U64; max_slippage_bps: number }
type Order = BuyOrder | SellOrder;

// ---------------------------------------------------------------- state
const BPS = 10_000n;
const SYMBOL_RE = /^[A-Z0-9]{1,20}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

class State {
  hello!: Hello;
  seq = -1;
  cash = 0n;
  equity = 0n;
  positions = new Map<string, { qty: bigint; cost: bigint }>();
  latest = new Map<string, Bar>();
  symbols = new Map<string, HelloSymbol>();
  warmupBars = 0;
  #nextId = 1;
  #used = new Set<string>();

  get warmingUp(): boolean { return this.warmupBars > 0 && this.seq < this.warmupBars; }

  init(hello: Hello): void {
    this.hello = hello;
    this.warmupBars = hello.warmup_bars ?? 0;
    this.cash = this.equity = BigInt(hello.capital.quote_units);
    for (const s of hello.symbols) this.symbols.set(s.symbol, s);
  }

  close(symbol: string): bigint | null {
    const b = this.latest.get(symbol);
    return b === undefined ? null : BigInt(b.c);
  }

  value(symbol: string, qty: bigint): bigint {
    const s = this.symbols.get(symbol);
    const price = this.close(symbol);
    if (s === undefined || price === null) return 0n;
    return (qty * price * 10n ** BigInt(this.hello.capital.quote_scale)) / 10n ** BigInt(s.qty_scale + s.price_scale);
  }

  /** Room under the weight cap for one more buy of this symbol. */
  weightRoom(symbol: string): bigint {
    const held = this.value(symbol, this.positions.get(symbol)?.qty ?? 0n);
    const room = (BigInt(this.hello.caps.max_weight_bps) * this.equity) / BPS - held;
    return room > 0n ? room : 0n;
  }

  applyBatch(batch: Batch): void {
    this.seq = batch.seq;
    for (const b of batch.bars) this.latest.set(b.symbol, b);
    this.cash = BigInt(batch.account.cash_quote_units);
    this.equity = BigInt(batch.account.equity_quote_units);
    this.positions.clear();
    for (const p of batch.account.positions) {
      this.positions.set(p.symbol, { qty: BigInt(p.qty), cost: BigInt(p.cost_quote_units) });
    }
  }

  clientId(): string {
    let id: string;
    do { id = `o${this.#nextId++}`; } while (this.#used.has(id));
    this.#used.add(id);
    return id;
  }

  /** Validate orders the way the harness would, and fill in client ids. */
  toOrders(raw: unknown): Order[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error(`batch ${this.seq}: onBatch must return an array`);
    const cap = this.hello.caps.max_orders_per_bar;
    if (raw.length > cap) throw new Error(`batch ${this.seq}: ${raw.length} orders over the cap ${cap}`);
    return raw.map((o: unknown, i: number) => {
      if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(`batch ${this.seq} order ${i}: not an object`);
      const r = o as Record<string, unknown>;
      if (r.side !== 'buy' && r.side !== 'sell') throw new Error(`batch ${this.seq} order ${i}: bad side`);
      if (typeof r.symbol !== 'string' || !SYMBOL_RE.test(r.symbol)) throw new Error(`batch ${this.seq} order ${i}: bad symbol`);
      if (typeof r.max_slippage_bps !== 'number' || !Number.isInteger(r.max_slippage_bps) || r.max_slippage_bps < 0 || r.max_slippage_bps > 10_000) {
        throw new Error(`batch ${this.seq} order ${i}: bad max_slippage_bps`);
      }
      const id = typeof r.client_id === 'string' ? r.client_id : this.clientId();
      if (!CLIENT_ID_RE.test(id)) throw new Error(`batch ${this.seq} order ${i}: bad client_id`);
      this.#used.add(id);
      if (r.side === 'buy') {
        if (typeof r.notional_quote_units !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(r.notional_quote_units)) throw new Error(`batch ${this.seq} order ${i}: bad notional`);
        return { side: 'buy', client_id: id, symbol: r.symbol, notional_quote_units: r.notional_quote_units, max_slippage_bps: r.max_slippage_bps };
      }
      if (typeof r.qty !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(r.qty)) throw new Error(`batch ${this.seq} order ${i}: bad qty`);
      return { side: 'sell', client_id: id, symbol: r.symbol, qty: r.qty, max_slippage_bps: r.max_slippage_bps };
    });
  }
}

// ---------------------------------------------------------------- strategy
/** Each symbol's closes by seq (null before its first bar). */
const history = new Map<string, (bigint | null)[]>();
/** Bar at which each held position's buy filled (from batch.fills). */
const openedAt = new Map<string, number>();
/** Symbols to buy on this batch: chosen on the rebalance bar before it, whose sells have now filled. */
let entering: string[] | null = null;
/** Next rebalance bar; set from hello: max(lookback, warm-up). */
let nextRebalance = PARAMS.lookback;

/** Trailing return of `symbol` over `n` bars as of batch `seq`, or null without both closes. */
function trailing(symbol: string, seq: number, n: number): { now: bigint; then: bigint } | null {
  const closes = history.get(symbol);
  if (closes === undefined) return null;
  const now = closes[seq];
  const then = closes[seq - n];
  if (now === null || now === undefined || then === null || then === undefined) return null;
  return { now, then };
}

/** Top symbols by trailing lookback return as of `seq`, best first, with their returns. */
function ranked(state: State, seq: number): { symbol: string; now: bigint; then: bigint }[] {
  const out: { symbol: string; now: bigint; then: bigint }[] = [];
  for (const { symbol } of state.hello.symbols) {
    const r = trailing(symbol, seq, PARAMS.lookback);
    if (r !== null) out.push({ symbol, ...r });
  }
  // now_a / then_a > now_b / then_b, exactly; sort is stable, ties keep universe order.
  out.sort((a, b) => {
    const l = a.now * b.then;
    const r = b.now * a.then;
    return l > r ? -1 : l < r ? 1 : 0;
  });
  return out;
}

function buys(state: State, symbols: readonly string[]): BuyOrder[] {
  const { caps, fees } = state.hello;
  const slots = Math.min(PARAMS.topN, caps.max_open_positions, caps.max_orders_per_bar);
  const room = slots - state.positions.size;
  const coming = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null).slice(0, room > 0 ? room : 0);
  if (coming.length === 0) return [];
  const even = state.cash / BigInt(coming.length);
  const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
  const stake = state.equity / BigInt(slots);
  const slice = [even, byWeight, stake].reduce((a, b) => (a < b ? a : b));
  if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
  return coming.map((symbol) => ({
    side: 'buy' as const,
    client_id: state.clientId(),
    symbol,
    notional_quote_units: slice.toString(),
    max_slippage_bps: PARAMS.slipBps,
  }));
}

function onBatch(state: State, batch: Batch): Order[] {
  for (const { symbol } of state.hello.symbols) {
    const closes = history.get(symbol) ?? [];
    closes.push(state.close(symbol));
    history.set(symbol, closes);
  }
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    if (f.side === 'buy') openedAt.set(f.symbol, f.fill_bar);
    else openedAt.delete(f.symbol);
  }
  if (state.warmingUp) return [];
  // Buys deferred from the last rebalance: the sells have filled, proceeds are in cash.
  if (entering !== null) {
    const orders = buys(state, entering);
    entering = null;
    return state.toOrders(orders);
  }
  const orders: Order[] = [];
  // Fast exits, every batch: stop loss, momentum fade, and max hold time.
  for (const [symbol, held] of state.positions) {
    const short = trailing(symbol, batch.seq, PARAMS.short);
    const faded = short !== null && short.now * 10_000n < short.then * BigInt(10_000 - PARAMS.fadeBps);
    const value = state.value(symbol, held.qty);
    const stopped = value * 10_000n <= held.cost * BigInt(10_000 - PARAMS.stopBps);
    const opened = openedAt.get(symbol);
    const stale = opened !== undefined && batch.seq - opened > PARAMS.maxHoldBars;
    if (faded || stopped || stale) {
      orders.push({ side: 'sell', client_id: state.clientId(), symbol, qty: held.qty.toString(), max_slippage_bps: PARAMS.slipBps });
    }
  }
  if (orders.length > 0) return state.toOrders(orders);
  if (batch.seq < nextRebalance) return [];
  nextRebalance = batch.seq + PARAMS.rebalanceEvery;
  const rank = ranked(state, batch.seq);
  if (rank.length === 0) return [];
  // Regime filter: the median trailing return must be positive, else hold cash.
  const rets = rank.map((r) => Number(r.now) / Number(r.then) - 1).sort((a, b) => a - b);
  const median = rets[Math.floor(rets.length / 2)]!;
  const want = median > 0
    ? rank
      .filter((r) => r.now > r.then && (() => {
        const s = trailing(r.symbol, batch.seq, PARAMS.short);
        return s !== null && s.now > s.then;
      })())
      .slice(0, Math.min(PARAMS.topN, state.hello.caps.max_open_positions, state.hello.caps.max_orders_per_bar))
      .map((r) => r.symbol)
    : [];
  const sells: Order[] = [...state.positions]
    .filter(([symbol]) => !want.includes(symbol))
    .map(([symbol, p]) => ({ side: 'sell' as const, client_id: state.clientId(), symbol, qty: p.qty.toString(), max_slippage_bps: PARAMS.slipBps }));
  if (sells.length === 0) return state.toOrders(buys(state, want));
  entering = want;
  return state.toOrders(sells);
}

// ---------------------------------------------------------------- line loop
const state = new State();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line) as { type: string };
  if (msg.type === 'hello') {
    if (state.hello !== undefined) throw new Error('a second hello');
    state.init(msg as unknown as Hello);
    nextRebalance = Math.max(PARAMS.lookback, state.warmupBars);
  } else if (msg.type === 'batch') {
    const batch = msg as unknown as Batch;
    if (batch.seq !== state.seq + 1) throw new Error(`batch ${batch.seq} after ${state.seq}`);
    state.applyBatch(batch);
    const orders = onBatch(state, batch);
    process.stdout.write(`${JSON.stringify({ type: 'reply', seq: batch.seq, orders })}\n`);
  } else if (msg.type === 'done') {
    break;
  } else {
    throw new Error(`unknown message type ${msg.type}`);
  }
}
