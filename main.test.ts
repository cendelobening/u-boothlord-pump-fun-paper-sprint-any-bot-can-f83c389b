// Unit tests for the ConfirmedFlow strategy in main.ts.
// Run with: node --test main.test.ts   (Node 22.18+ / 24, type stripping on)
//
// The tests drive the real BotState from the vendored shim with synthetic
// hello/batch messages, exactly as the harness does: applyBatch first, then
// the strategy decides orders for that batch.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BotState } from './vendor/makefun-bot.ts';
import type { Batch, Fill, Hello, TradeEventRecord } from './vendor/makefun-bot.ts';
import { ConfirmedFlow } from './main.ts';

const SOL = 1_000_000_000n;
const MINT_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const MINT_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function mkHello(): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '0',
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 1, residue: 0 },
    },
    capital: { lamports: (10n * SOL).toString() },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: {
      protocol_bps_fallback: 95,
      creator_bps_fallback: 30,
      base_fee_lamports: '5000',
      priority_fee_lamports: '100000',
      failed_tx_bps: 200,
    },
  } as Hello;
}

// A trade at a given price level: virtual_token fixed, virtual_quote moves the
// spot price. `level` is the virtual SOL reserve in lamports (price proxy).
function trade(mint: string, slot: number, isBuy: boolean, solLamports: bigint, level: bigint, seqInSlot: number): TradeEventRecord {
  return {
    event: 'TradeEvent',
    mint,
    slot,
    signature: `sig-${mint}-${slot}-${seqInSlot}`,
    chain_seq: seqInSlot,
    block_time: null,
    sol_amount: solLamports.toString(),
    token_amount: '1000000',
    is_buy: isBuy,
    user: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    timestamp: '0',
    virtual_sol_reserves: level.toString(),
    virtual_token_reserves: '1000000000000',
    real_sol_reserves: (6n * SOL).toString(),
    real_token_reserves: '900000000000',
    virtual_quote_reserves: level.toString(),
    virtual_token_reserves_unused: undefined,
    real_quote_reserves: (6n * SOL).toString(),
    quote_amount: solLamports.toString(),
  } as unknown as TradeEventRecord;
}

interface Stage {
  state: BotState;
  strategy: ConfirmedFlow;
  seq: number;
}

function mkStage(): Stage {
  return { state: new BotState(mkHello()), strategy: new ConfirmedFlow(), seq: 0 };
}

/** Feed one batch through state + strategy, returning the decided orders. */
function feed(st: Stage, slot: number, events: TradeEventRecord[], fills: Fill[] = [], account?: { cash: bigint; positions: { mint: string; token_amount: string; cost_lamports: string }[] }) {
  const batch = {
    type: 'batch',
    seq: st.seq++,
    slot,
    events,
    marks: [],
    fills,
    account: account !== undefined
      ? { cash_lamports: account.cash.toString(), positions: account.positions }
      : { cash_lamports: st.state.cash.toString(), positions: [...st.state.positions.entries()].map(([mint, p]) => ({ mint, token_amount: p.token_amount.toString(), cost_lamports: p.cost_lamports.toString() })) },
  } as unknown as Batch;
  st.state.applyBatch(batch);
  return st.strategy.decide(st.state, batch);
}

/** A batch of buy-heavy, rising-price trades on `mint` around `slot`. */
function bullishEvents(mint: string, slot: number): TradeEventRecord[] {
  const evs: TradeEventRecord[] = [];
  let level = 50_000_000_000n; // spot: 50_000_000_000 / 1e12 = 0.05 lamports per token unit
  for (let i = 0; i < 10; i++) {
    level = (level * 101n) / 100n; // +1% per trade: clear positive momentum
    evs.push(trade(mint, slot, true, 200_000_000n, level, i));
  }
  for (let i = 0; i < 2; i++) {
    evs.push(trade(mint, slot, false, 50_000_000n, level, 10 + i));
  }
  return evs;
}

function bearishEvents(mint: string, slot: number): TradeEventRecord[] {
  const evs: TradeEventRecord[] = [];
  let level = 50_000_000_000n;
  for (let i = 0; i < 10; i++) {
    level = (level * 99n) / 100n;
    evs.push(trade(mint, slot, false, 200_000_000n, level, i));
  }
  evs.push(trade(mint, slot, true, 50_000_000n, level, 10));
  return evs;
}

test('entry fires on buy-flow dominance with positive momentum', () => {
  const st = mkStage();
  let orders = feed(st, 100, bullishEvents(MINT_A, 100));
  const buy = orders.find((o) => o.side === 'buy' && o.mint === MINT_A);
  assert.ok(buy, 'expected a buy order for the bullish mint');
  if (buy && buy.side === 'buy') {
    const size = BigInt(buy.quote_lamports as string);
    assert.ok(size >= 10_000_000n, `size ${size} below the 0.01 SOL guardrail minimum`);
    assert.ok(size <= st.state.maxBuyLamports(MINT_A), 'size exceeds the reserve cap');
  }
});

test('no entry when sell flow dominates', () => {
  const st = mkStage();
  const orders = feed(st, 100, bearishEvents(MINT_A, 100));
  assert.equal(orders.filter((o) => o.side === 'buy').length, 0);
});

test('no entry on a thin window (too few trades)', () => {
  const st = mkStage();
  const few = bullishEvents(MINT_A, 100).slice(0, 3);
  const orders = feed(st, 100, few);
  assert.equal(orders.filter((o) => o.side === 'buy').length, 0);
});

/** Open a filled position on MINT_A: returns the stage parked at entry price. */
function openPosition(): { st: Stage; tokens: bigint; cost: bigint; fillSlot: number } {
  const st = mkStage();
  const orders = feed(st, 100, bullishEvents(MINT_A, 100));
  const buy = orders.find((o) => o.side === 'buy');
  assert.ok(buy && buy.side === 'buy');
  const wire = st.state.toOrders(orders);
  st.state.recordOrders(wire);
  const size = BigInt(buy.quote_lamports as string);
  // Entry spot after the ten +1% steps is level 55_231_000_000 (virtual quote
  // over 1e12 virtual tokens). Size the token amount so the position's spot
  // value at entry equals its cost: the position starts at ~0% PnL.
  const tokens = (size * 1_000_000_000_000n) / 55_231_000_000n;
  const fillSlot = 102;
  const fill = {
    client_id: wire[0].client_id,
    mint: MINT_A,
    side: 'buy',
    status: 'filled',
    reason: null,
    decided_slot: 100,
    slot: fillSlot,
    quote_lamports: size.toString(),
    token_amount: tokens.toString(),
    fee_lamports: '0',
    tx_fee_lamports: '105000',
    fee_fallback: true,
  } as unknown as Fill;
  const cost = size; // harness reports cost with fees included; ~= the SOL spent
  const account = { cash: 10n * SOL - size, positions: [{ mint: MINT_A, token_amount: tokens.toString(), cost_lamports: cost.toString() }] };
  feed(st, fillSlot, [], [fill], account);
  return { st, tokens, cost, fillSlot };
}

function markBatch(st: Stage, slot: number, level: bigint) {
  const batch = {
    type: 'batch',
    seq: st.seq++,
    slot,
    events: [],
    marks: [{
      mint: MINT_A,
      slot,
      virtual_token_reserves: '1000000000000',
      virtual_quote_reserves: level.toString(),
      real_token_reserves: '900000000000',
      real_quote_reserves: (6n * SOL).toString(),
    }],
    fills: [],
    account: { cash_lamports: st.state.cash.toString(), positions: [...st.state.positions.entries()].map(([mint, p]) => ({ mint, token_amount: p.token_amount.toString(), cost_lamports: p.cost_lamports.toString() })) },
  } as unknown as Batch;
  st.state.applyBatch(batch);
  return st.strategy.decide(st.state, batch);
}

test('take-profit exit fires on a strong mark-up', () => {
  const { st, tokens } = openPosition();
  // +12% over the entry spot level (~55.231e9) -> well past the +3.5% take-profit.
  const orders = markBatch(st, 110, 62_000_000_000n);
  const sell = orders.find((o) => o.side === 'sell' && o.mint === MINT_A);
  assert.ok(sell, 'expected a take-profit sell');
  if (sell && sell.side === 'sell') {
    assert.equal(BigInt(sell.token_amount as string), tokens);
    assert.equal(sell.max_slippage_bps, 600);
  }
});

test('stop-loss exit fires on a sharp mark-down', () => {
  const { st } = openPosition();
  // -15% under the entry spot level -> past the -6% stop-loss.
  const orders = markBatch(st, 110, 47_000_000_000n);
  const sell = orders.find((o) => o.side === 'sell' && o.mint === MINT_A);
  assert.ok(sell, 'expected a stop-loss sell');
  if (sell) assert.equal(sell.max_slippage_bps, 1200);
});

test('time-stop exit fires after the holding limit even at a flat price', () => {
  const { st, fillSlot } = openPosition();
  const orders = markBatch(st, fillSlot + 240, 55_231_000_000n);
  const sell = orders.find((o) => o.side === 'sell' && o.mint === MINT_A);
  assert.ok(sell, 'expected a time-stop sell');
});

test('determinism: identical event streams give identical orders', () => {
  const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const run = () => {
    const st = mkStage();
    const log: string[] = [];
    log.push(ser(feed(st, 100, bullishEvents(MINT_A, 100))));
    log.push(ser(feed(st, 101, bullishEvents(MINT_B, 101))));
    log.push(ser(feed(st, 102, bearishEvents(MINT_A, 102))));
    log.push(ser(feed(st, 103, [])));
    return log.join('\n');
  };
  assert.equal(run(), run());
});
