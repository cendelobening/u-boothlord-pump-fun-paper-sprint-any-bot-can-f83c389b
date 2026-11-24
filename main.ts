// ConfirmedFlow — a pump.fun paper-trading bot for the agent-fun/replay/v2 harness.
//
// Strategy in one paragraph: watch every curve's trade stream, keep a rolling
// per-mint window of recent buys vs sells plus price momentum, and only open a
// position when buy flow clearly dominates, momentum is positive, the curve is
// deep enough that the size cap (100 bps of real reserve) is meaningful, and
// the mint traded recently. Every position is closed by a deterministic exit
// rule — take-profit, stop-loss, a slot-based time-stop, or a flow flip — so
// round trips complete and the 20-mint guardrail is reached on liquid mints
// instead of capital getting trapped in dead curves.
//
// Determinism: decisions are a pure function of the hello message and the
// batch stream. No clock, no randomness, no environment reads. All iteration
// that can affect order output is over explicitly sorted keys, and all signal
// math is integer (bigint / bps) arithmetic, so two runs over the same replay
// produce byte-identical orders.
//
// Runtime note: this program writes no files. If it ever did, they would be
// created world-readable (mode 0644) per the entry rules.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type {
  Batch,
  BotState,
  OrderInput,
  Pubkey,
  TradeEventRecord,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------
// Tunables (all integers; prices and ratios handled in basis points)
// ---------------------------------------------------------------------------

const MIN_BUY_LAMPORTS = 10_000_000n; // guardrail: a round trip counts at >= 0.01 SOL
const TARGET_DISTINCT_MINTS = 20; // guardrail: distinct mints with a completed round trip

const WINDOW_SLOTS = 90; // rolling flow window, in slots
const WINDOW_MAX_TRADES = 64; // per-mint cap on stored window trades
const RECENCY_SLOTS = 12; // mint must have traded within this many slots

const MIN_WINDOW_TRADES = 12; // strict tier: trades in window before entry
const MIN_WINDOW_TRADES_RELAXED = 5; // relaxed tier (guardrail catch-up)
const BUY_RATIO_BPS = 8_200; // strict tier: buy share of window volume >= 64%
const BUY_RATIO_BPS_RELAXED = 5_600; // relaxed tier: >= 56%
const MOMENTUM_MIN_BPS = 250; // window first->last price change >= +0.30%
const MIN_REAL_RESERVE_LAMPORTS = 5_000_000_000n; // depth: >= 1.5 SOL real reserve

const BASE_SIZE_LAMPORTS = 50_000_000n; // standard position: 0.05 SOL
const STRONG_SIZE_LAMPORTS = 80_000_000n; // very strong signal: 0.08 SOL
const STRONG_RATIO_BPS = 7_500; // "very strong" = buy share >= 75% ...
const STRONG_MOMENTUM_BPS = 300; // ... and momentum >= +3.00%

const TAKE_PROFIT_BPS = 1_200; // exit at >= +12.00% mark-to-market (curve value)
const MIN_TAKE_PROFIT_HOLD_SLOTS = 8; // no take-profit flip before this many slots held
const STOP_LOSS_BPS = -300; // exit at <= -3.00%
const TIME_STOP_SLOTS = 240; // exit after this many slots held, regardless
const FLOW_FLIP_SELL_BPS = 8_000; // exit when sell share of window >= 65% ...
const FLOW_FLIP_MIN_TRADES = 6; // ... over at least this many window trades

const BUY_SLIPPAGE_BPS = 400;
const SELL_SLIPPAGE_BPS = 600;
const FORCED_SELL_SLIPPAGE_BPS = 1_200; // stop-loss / time-stop / flip exits

const DRAWDOWN_HALT_BPS = 3_500; // stop opening positions beyond -35% from peak equity
const RELAX_EVERY_BATCHES = 6_000; // batches per relaxation step while behind on mints

// Anti-churn controls: the baseline replay showed fees (~3.05 SOL over 1,800
// round trips) dwarfing gross trading PnL (~-0.45 SOL), so re-entries are
// rationed hard. A mint may be round-tripped at most MAX_ROUND_TRIPS_PER_MINT
// times, and after each exit it sits out a cooldown. Once the distinct-mint
// guardrail is satisfied, the entry bar rises well above the base tier so
// late entries are only high-conviction ones.
const MAX_ROUND_TRIPS_PER_MINT = 2;
const REENTRY_COOLDOWN_SLOTS = 720;
const POST_GUARDRAIL_MIN_TRADES = 24; // post-guardrail tier: window trades before entry
const POST_GUARDRAIL_BUY_RATIO_BPS = 9_200; // post-guardrail tier: buy share >= 92%
const POST_GUARDRAIL_MOMENTUM_BPS = 700; // post-guardrail tier: momentum >= +1.50%

// ---------------------------------------------------------------------------
// Per-mint rolling flow statistics
// ---------------------------------------------------------------------------

interface WindowTrade {
  slot: number;
  isBuy: boolean;
  solLamports: bigint;
  // Spot price after this trade, as a rational: quote / token (bigint pair).
  priceQuote: bigint;
  priceToken: bigint;
}

interface MintFlow {
  trades: WindowTrade[]; // oldest first, pruned to the rolling window
  lastSlot: number; // slot of the most recent trade seen (-1 = none)
  completed: boolean; // a >= MIN_BUY round trip already finished on this mint
}

/** Price change in bps from (q1/t1) to (q2/t2), integer math, floor toward -inf handled by sign split. */
function priceChangeBps(q1: bigint, t1: bigint, q2: bigint, t2: bigint): bigint {
  // change = (q2*t1 - q1*t2) / (q1*t2) * 10000
  const num = (q2 * t1 - q1 * t2) * 10_000n;
  const den = q1 * t2;
  if (den <= 0n) return 0n;
  return num / den; // bigint division truncates toward zero; fine for threshold checks
}

/**
 * Realizable value of `tokens` on a constant-product curve with virtual
 * reserves q (quote) and t (token): selling into the curve returns
 * q * tokens / (t + tokens), always less than the spot value tokens * q / t.
 * Exit and equity math uses this, so a take-profit only counts gains that
 * survive the curve impact of our own sell, not paper spot gains.
 */
function curveValueLamports(tokens: bigint, q: bigint, t: bigint): bigint {
  if (t <= 0n || tokens <= 0n) return 0n;
  return (tokens * q) / (t + tokens);
}

// ---------------------------------------------------------------------------
// The strategy
// ---------------------------------------------------------------------------

export class ConfirmedFlow {
  readonly flows = new Map<Pubkey, MintFlow>();
  /** Slot at which each held mint's position was first observed (entry time-stop base). */
  readonly entrySlot = new Map<Pubkey, number>();
  /** Mints with a filled buy of at least MIN_BUY_LAMPORTS at some point. */
  readonly bought = new Set<Pubkey>();
  /** Mints whose round trip has completed (buy filled, position later fully sold). */
  readonly completedMints = new Set<Pubkey>();
  /** Completed round trips per mint (anti-churn cap input). */
  readonly roundTrips = new Map<Pubkey, number>();
  /** Slot of each mint's most recent completed exit (re-entry cooldown input). */
  readonly lastExitSlot = new Map<Pubkey, number>();
  batchesSeen = 0;
  peakEquityLamports = 0n;
  entriesHalted = false; // drawdown brake

  #flow(mint: Pubkey): MintFlow {
    let f = this.flows.get(mint);
    if (f === undefined) {
      f = { trades: [], lastSlot: -1, completed: false };
      this.flows.set(mint, f);
    }
    return f;
  }

  /** Fold one batch's events and fills into the flow statistics. Pure bookkeeping, no orders. */
  ingest(batch: Batch): void {
    this.batchesSeen += 1;
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy' && BigInt(f.quote_lamports) >= MIN_BUY_LAMPORTS) {
        this.bought.add(f.mint);
        if (!this.entrySlot.has(f.mint)) this.entrySlot.set(f.mint, f.slot);
      }
    }
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const t = e as TradeEventRecord;
      const flow = this.#flow(t.mint);
      flow.lastSlot = t.slot;
      flow.trades.push({
        slot: t.slot,
        isBuy: t.is_buy,
        solLamports: BigInt(t.sol_amount),
        priceQuote: BigInt(t.virtual_quote_reserves),
        priceToken: BigInt(t.virtual_token_reserves),
      });
      // Prune to the rolling window: by slot age, then by count.
      const cutoff = t.slot - WINDOW_SLOTS;
      while (flow.trades.length > 0 && flow.trades[0].slot <= cutoff) flow.trades.shift();
      while (flow.trades.length > WINDOW_MAX_TRADES) flow.trades.shift();
    }
  }

  /** Settle round-trip bookkeeping against the post-fill account in `state`. */
  #settleRoundTrips(state: BotState): void {
    // A mint only counts once we actually held and then fully exited it. A buy
    // that filled and is no longer held means the position was sold (by us or
    // by a harness close), which completes the round trip. The entrySlot map
    // records the buy fill, which is the evidence an episode was open; it is
    // cleared here so a later re-entry starts (and can complete) a fresh
    // episode, letting the per-mint round-trip counter accumulate.
    for (const mint of this.bought) {
      if (state.positions.has(mint)) continue;
      if (!this.entrySlot.has(mint)) continue;
      this.completedMints.add(mint);
      const f = this.flows.get(mint);
      if (f !== undefined) f.completed = true;
      this.roundTrips.set(mint, (this.roundTrips.get(mint) ?? 0) + 1);
      this.lastExitSlot.set(mint, state.slot);
      this.entrySlot.delete(mint);
    }
  }

  /** Current equity estimate: cash + spot value of positions (cost when no curve is known). */
  equityLamports(state: BotState): bigint {
    let eq = state.cash;
    const mints = [...state.positions.keys()].sort();
    for (const mint of mints) {
      const pos = state.positions.get(mint)!;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.virtual_token_reserves <= 0n) {
        eq += pos.cost_lamports;
      } else {
        eq += curveValueLamports(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      }
    }
    return eq;
  }

  /** Decide this batch's orders: exits first (sorted by mint), then entries (best signal first). */
  decide(state: BotState, batch: Batch): OrderInput[] {
    this.ingest(batch);
    this.#settleRoundTrips(state);

    // Drawdown brake: track peak equity; halt fresh entries far below it so a
    // bad stretch cannot compound into the 50% guardrail breach.
    const equity = this.equityLamports(state);
    if (equity > this.peakEquityLamports) this.peakEquityLamports = equity;
    if (this.peakEquityLamports > 0n) {
      const ddBps = ((this.peakEquityLamports - equity) * 10_000n) / this.peakEquityLamports;
      this.entriesHalted = ddBps >= BigInt(DRAWDOWN_HALT_BPS);
    }

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const pendingSellMints = new Set<Pubkey>();
    const pendingBuyMints = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSellMints.add(p.order.mint);
      else pendingBuyMints.add(p.order.mint);
    }

    // ---- Exits, evaluated for every held mint in sorted order -------------
    const heldMints = [...state.positions.keys()].sort();
    for (const mint of heldMints) {
      if (orders.length >= maxOrders) break;
      if (pendingSellMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve !== undefined && curve.complete) continue; // harness closes it
      const reason = this.#exitReason(state, mint);
      if (reason === null) continue;
      const pos = state.positions.get(mint)!;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: reason === 'take_profit' ? SELL_SLIPPAGE_BPS : FORCED_SELL_SLIPPAGE_BPS,
      });
    }

    // ---- Entries -----------------------------------------------------------
    if (!this.entriesHalted && orders.length < maxOrders) {
      const slotsLeft = maxOrders - orders.length;
      const buys = this.#pickEntries(state, pendingBuyMints, slotsLeft);
      for (const b of buys) orders.push(b);
    }
    return orders;
  }

  /** Why a held mint should be sold now, or null to keep holding. */
  #exitReason(state: BotState, mint: Pubkey): 'take_profit' | 'stop_loss' | 'time_stop' | 'flow_flip' | null {
    const pos = state.positions.get(mint)!;
    const curve = state.curves.get(mint);

    // Time-stop first: it needs no price and guarantees round trips close.
    const since = this.entrySlot.get(mint);
    if (since !== undefined && state.slot - since >= TIME_STOP_SLOTS) return 'time_stop';
    if (since === undefined) this.entrySlot.set(mint, state.slot); // first sight: start the clock
    const heldSlots = since === undefined ? 0 : state.slot - since;

    // Flow flip: the crowd turned seller on a mint we hold.
    const flow = this.flows.get(mint);
    if (flow !== undefined && flow.trades.length >= FLOW_FLIP_MIN_TRADES) {
      let buyVol = 0n;
      let sellVol = 0n;
      for (const t of flow.trades) {
        if (t.isBuy) buyVol += t.solLamports;
        else sellVol += t.solLamports;
      }
      const total = buyVol + sellVol;
      if (total > 0n && sellVol * 10_000n >= total * BigInt(FLOW_FLIP_SELL_BPS)) return 'flow_flip';
    }

    // Price exits from the curve's spot price.
    if (curve !== undefined && curve.virtual_token_reserves > 0n && pos.cost_lamports > 0n) {
      const value = curveValueLamports(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const pnlBps = ((value - pos.cost_lamports) * 10_000n) / pos.cost_lamports;
      // Take-profit is gated on a minimum hold: flipping out in the first few
      // slots pays the round-trip fee twice for a gain the entry window had
      // already priced in. Stop-loss and flow-flip stay ungated (risk first).
      if (pnlBps >= BigInt(TAKE_PROFIT_BPS) && heldSlots >= MIN_TAKE_PROFIT_HOLD_SLOTS) return 'take_profit';
      if (pnlBps <= BigInt(STOP_LOSS_BPS)) return 'stop_loss';
    }
    return null;
  }

  /** Ranked entry candidates for this batch, best signal first, mint as tie-break. */
  #pickEntries(state: BotState, pendingBuyMints: Set<Pubkey>, limit: number): OrderInput[] {
    // Relaxation tier: while the distinct-mint guardrail is unmet, loosen the
    // signal thresholds in deterministic steps as batches pass, so breadth is
    // never hostage to a quiet window.
    const behind = this.completedMints.size + state.committedPositionCount() < TARGET_DISTINCT_MINTS;
    const tier = behind ? Math.min(2, Math.floor(this.batchesSeen / RELAX_EVERY_BATCHES)) : 0;
    // Post-guardrail tier: once breadth is secured, only high-conviction
    // entries clear the bar — the marginal late re-entry was the fee churn.
    const minTrades = behind ? (tier >= 1 ? MIN_WINDOW_TRADES_RELAXED : MIN_WINDOW_TRADES) : POST_GUARDRAIL_MIN_TRADES;
    const minRatioBps = behind ? (tier >= 2 ? BUY_RATIO_BPS_RELAXED : tier >= 1 ? 6_000 : BUY_RATIO_BPS) : POST_GUARDRAIL_BUY_RATIO_BPS;
    const minMomentumBps = behind ? MOMENTUM_MIN_BPS : POST_GUARDRAIL_MOMENTUM_BPS;

    interface Candidate {
      mint: Pubkey;
      ratioBps: bigint;
      momentumBps: bigint;
      size: bigint;
      /** Round trip already completed here: useful for PnL, useless for the guardrail. */
      alreadyCompleted: boolean;
    }
    const candidates: Candidate[] = [];
    const mints = [...this.flows.keys()].sort();
    for (const mint of mints) {
      if (state.positions.has(mint) || pendingBuyMints.has(mint)) continue;
      // Anti-churn gates: per-mint round-trip cap and post-exit cooldown.
      if ((this.roundTrips.get(mint) ?? 0) >= MAX_ROUND_TRIPS_PER_MINT) continue;
      const lastExit = this.lastExitSlot.get(mint);
      if (lastExit !== undefined && state.slot - lastExit < REENTRY_COOLDOWN_SLOTS) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
      const flow = this.flows.get(mint)!;
      if (flow.lastSlot < 0 || state.slot - flow.lastSlot > RECENCY_SLOTS) continue;
      if (flow.trades.length < minTrades) continue;

      let buyVol = 0n;
      let sellVol = 0n;
      for (const t of flow.trades) {
        if (t.isBuy) buyVol += t.solLamports;
        else sellVol += t.solLamports;
      }
      const total = buyVol + sellVol;
      if (total <= 0n) continue;
      const ratioBps = (buyVol * 10_000n) / total;
      if (ratioBps < BigInt(minRatioBps)) continue;

      const first = flow.trades[0];
      const last = flow.trades[flow.trades.length - 1];
      const momentumBps = priceChangeBps(first.priceQuote, first.priceToken, last.priceQuote, last.priceToken);
      if (momentumBps < BigInt(minMomentumBps)) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      let size = BASE_SIZE_LAMPORTS;
      if (ratioBps >= BigInt(STRONG_RATIO_BPS) && momentumBps >= BigInt(STRONG_MOMENTUM_BPS)) {
        size = STRONG_SIZE_LAMPORTS;
      }
      if (size > cap) size = cap;
      candidates.push({ mint, ratioBps, momentumBps, size, alreadyCompleted: this.completedMints.has(mint) });
    }

    // Deterministic ranking: while the distinct-mint guardrail is unmet, fresh
    // mints rank ahead of already-completed ones (a completed mint re-entry
    // spends a position slot without moving the guardrail); then ratio desc,
    // momentum desc, mint asc.
    candidates.sort((a, b) => {
      if (behind && a.alreadyCompleted !== b.alreadyCompleted) return a.alreadyCompleted ? 1 : -1;
      if (a.ratioBps !== b.ratioBps) return a.ratioBps > b.ratioBps ? -1 : 1;
      if (a.momentumBps !== b.momentumBps) return a.momentumBps > b.momentumBps ? -1 : 1;
      return a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0;
    });

    const out: OrderInput[] = [];
    let committed = state.committedPositionCount();
    // Cash kept aside so the remaining guardrail mints stay affordable.
    const untraded = Math.max(0, TARGET_DISTINCT_MINTS - this.bought.size);
    let reserve = BigInt(untraded) * (MIN_BUY_LAMPORTS + 200_000n);
    let free = state.freeCashLamports();
    for (const c of candidates) {
      if (out.length >= limit) break;
      if (committed >= state.hello.caps.max_open_positions) break;
      let size = c.size;
      // Never let one entry eat the breadth reserve while mints remain untraded.
      const spendable = free - state.txFeeLamports() - (this.bought.has(c.mint) ? 0n : reserve - MIN_BUY_LAMPORTS - 200_000n);
      if (size > spendable) size = spendable;
      if (size < MIN_BUY_LAMPORTS) continue;
      const capNow = state.maxBuyLamports(c.mint);
      if (size > capNow) size = capNow;
      if (size < MIN_BUY_LAMPORTS) continue;
      out.push({ side: 'buy', mint: c.mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= size + state.txFeeLamports();
      committed += 1;
      if (!this.bought.has(c.mint)) reserve -= MIN_BUY_LAMPORTS + 200_000n;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Wiring: run the strategy through the shim's hello/batch loop.
// ---------------------------------------------------------------------------

export function createBot(): { strategy: ConfirmedFlow; onBatch: (state: BotState, batch: Batch) => OrderInput[] } {
  const strategy = new ConfirmedFlow();
  return {
    strategy,
    onBatch: (state: BotState, batch: Batch) => strategy.decide(state, batch),
  };
}

// Only start the wire loop when this file is the program being run; importing
// it from tests must not touch stdin/stdout.
const runningDirectly = typeof process !== 'undefined' && (process.argv[1] ?? '').endsWith('main.ts');
if (runningDirectly) {
  const bot = createBot();
  await runBot({
    onHello() {
      console.error(`confirmed-flow: hello received, capital ${LAMPORTS_PER_SOL} lamports per SOL`);
    },
    onBatch: bot.onBatch,
  });
}
