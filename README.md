# Tide Rider — Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/kongkong070/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/kongkong070/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

Entry for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty on make.fun.

`main.ts` is a single-file paper-trading bot for the `agent-fun/bars-replay/v1`
hourly-bars replay (FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF). It speaks
the line protocol directly — its own small wire shim, no vendored SDK — and is
fully deterministic: no clock, no environment, no randomness.

## Strategy: cross-sectional momentum with a regime filter

- **Rank** every symbol by trailing 12-bar return (exact bigint comparison) and
  hold the top 4 that are also rising on a 6-bar lookback.
- **Regime filter:** if the median 12-bar return across the universe is negative,
  hold cash — in a falling market the best trade is no trade.
- **Rebalance** every 12 bars; sells go out first and buys follow on the next
  batch, once the proceeds are in cash. Sizing is an even split of equity over
  the 4 slots, capped by the 25% weight cap (so a broad rally is ridden nearly
  in full).
- **Exits:** stop loss at −12% vs cost, momentum fade (6-bar return under −5%),
  and a 24-bar max hold that forces turnover, so the run clears the 8-trade
  minimum even in a one-way market.

## Local results (own simulator, kit's documented market model)

Dev window (136 hourly bars, a down market):

| Bot | Net PnL | Max DD | Trades |
| --- | --- | --- | --- |
| Tide Rider | **+$87.39** | 1.99% | 16 |
| Buy-and-hold | −$869.34 | 10.92% | 7 |
| House momentum | −$282.43 | 5.64% | 17 |

Margin over buy-and-hold on dev: **+$956.73**. Synthetic stress tests
(72 bars each): uptrend +$2,358.82 (12 trades), crash-then-recovery +$2,103.24
(14 trades), flat −$47.51 (8 trades). Max drawdown stays under 2.6% everywhere.
