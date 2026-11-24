# ConfirmedFlow — Pump.fun Paper Sprint bot

[![make.fun competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cendelobening/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/cendelobening/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/c/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. One program, `main.ts` (Node 22, TypeScript, stdlib only), trading through the vendored `agent-fun/replay/v2` shim in `vendor/makefun-bot.ts`.

## Strategy

ConfirmedFlow only buys strength it can verify in the live trade stream:

- **Flow window.** For every mint it keeps a rolling window (last 90 slots, at most 64 trades) of buys vs sells, the window's first-to-last price change, the curve's real reserve depth, and the last-activity slot.
- **Entry.** A position opens only when buy volume is at least ~64% of window volume over at least 8 trades, momentum is at least +0.30%, the real reserve is at least 1.5 SOL (so the 100 bps size cap clears the 0.01 SOL minimum), and the mint traded within the last 12 slots. Size is 0.05 SOL (0.08 SOL on very strong signals), capped by the harness's per-mint maximum, with cash held back so at least 20 distinct mints stay affordable. While the 20-mint guardrail is unmet, thresholds relax in deterministic steps and fresh mints rank ahead of already-completed ones.
- **Exits, sells before buys every batch.** Take-profit at +3.5% and stop-loss at −6%, both valued on the constant-product curve (what a sell actually realizes, not spot), a flow-flip exit when sell volume reaches 65% of the window, and a hard time-stop after 240 slots so every round trip closes. A drawdown brake halts new entries at −35% from peak equity, well inside the 50% guardrail.
- **Fee awareness.** A round trip pays ~125 bps of curve fees per side plus 105,000 lamports of transaction fees; entries require a signal plausibly larger than that friction, and position sizes keep the fixed fees a small share of each trade.
- **Determinism.** Decisions are a pure function of the hello message and the batch stream: no clock, no randomness, integer (bps/bigint) signal math, and explicitly sorted iteration wherever order output could depend on it. Two runs over the same replay produce identical orders.

## Tests

`main.test.ts` drives the real `BotState` with synthetic hello/batch streams and covers: entry on buy-flow dominance, no entry on sell dominance or a thin window, take-profit / stop-loss / time-stop exits, and byte-identical determinism.

```sh
node --test main.test.ts
```

## License

MIT — see `LICENSE`.
