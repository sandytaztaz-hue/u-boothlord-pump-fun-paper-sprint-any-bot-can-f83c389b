# Fast-Reserve Runner — Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun entry](https://make.fun/badge/entry/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun leaderboard](https://make.fun/badge/leaderboard/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

SPDX-License-Identifier: MIT

A bot for the make.fun competition
[u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
("Pump.fun Paper Sprint: Any Bot Can Win"). One program, `main.ts` (Node 22),
paper-trades pump.fun while the house replays 6 hours of real data. Highest
net PnL wins.

## Strategy: buy only the fast risers, ride the grinders

The data (kit's full 24h dev replay, 1,222 coins) says the strongest signal is
**real-reserve speed**: coins that reach 20 SOL of real reserves within ~60
slots of creation are ~48% likely to reach 50+ SOL (and ~35% complete); coins
that take longer almost never do. So the entry is gated on both the level
(20 SOL) and the speed (<= 60 slots). Everything else is a dud, and buying
every coin small is a guaranteed slow bleed (gross expectancy ~0, ~3% fees).

- **Entry:** first buy when a coin's real reserves cross 20 SOL within 60
  slots of creation, while reserves are still in the [20, 40] SOL band.
  Size is capped by the 1%-of-real-reserve order cap (~0.2 SOL at rq 20).
- **Pyramid:** add 0.5 SOL at real-reserve milestones 40 and 60 SOL, but only
  while the position is in profit and the price is above the last add.
- **Exits:** tight 10% stop on the entry; value take-profit that banks 60% of
  tokens at +100%; top-bank of 90% at 100 SOL real reserves; trailing stop
  (20% for runners); stall exit when reserves drain 15% from their peak;
  hard time limits (1,000 slots non-runner, 5,000 runner).
- **Guardrail:** tiny 0.01 SOL probe round trips keep the 20-coin minimum met
  (at most two probe slots, so runner entries always have room). Probes sell
  within a few slots — before the coin can dump to zero real reserves, which
  would make the tokens unsellable and the position slot stuck.
- **Deterministic:** no clock, no randomness, insertion-ordered maps only, so
  the two grading runs produce byte-identical action logs.

## Local replay (kit `grade-local`, server's way)

Full 24h dev dataset, mean over 4 fail keys:

| Metric | Value |
| --- | --- |
| Net PnL | **+1.000 SOL** (worst +0.909 across fail keys) |
| Max drawdown | 0.15 (guardrail ≤ 0.50) |
| Coins with round trips ≥ 0.01 SOL | 112 (guardrail ≥ 20) |
| Round trips / wins | 147 / 18 |
| Fills | ~370 |

For comparison on the same dataset: the kit's pilot momentum bot scores
−9.454 SOL, a buy-everything scalp scores −0.632 SOL, and the house
equal-weight baseline is ≈ −0.423 SOL. The judge's final PnL is measured on a
fresh 6h window after the deadline, so no number here is a judge score.

## Run

```sh
# with the competition kit at ../kit
node ../kit/cli/makefun.mjs grade-local --kit ../kit --bot . --driver process
```

## Files

- `main.ts` — entrypoint; runs the strategy through the kit SDK.
- `strategy.ts` — the Fast-Reserve Runner (all trading logic).
- `vendor/makefun-bot.ts` — the kit's SDK, vendored as the kit sanctions.

## License

MIT — see `LICENSE`.
