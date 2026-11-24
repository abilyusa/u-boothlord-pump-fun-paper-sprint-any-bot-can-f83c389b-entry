# Pump.fun Paper Sprint — Launch-Snipe Bot

[![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/abilyusa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/abilyusa/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the `pumpfun-replay/v2` harness. It replays Pump.fun
bonding-curve data and trades it with a fixed rule set — no model, no network,
no randomness beyond the harness seed.

## Strategy (in plain words)

Buy fresh launches, exit fast, let the rare runner run.

- **Entry — launch snipe.** A coin is buyable only within 3 slots of its
  create, while its real SOL is 0.3–30, the creator's own buys total ≤ 2.5 SOL,
  at most **1** distinct non-creator buyer has appeared, and the creator has not
  sold. Stake **0.02 SOL** per coin, bought in slices of at most 1% of the coin's
  real SOL reserve per batch (the harness cap), topped up for up to 6 slots.
  The 0.01 SOL minimum per buy slice means coins with under ~1 SOL of real
  reserves are effectively skipped.
- **Exits.** Sell everything at +15% (take-profit), −12% (stop-loss), after 10
  slots held, or the moment the creator sells. Optionally a partial
  take-profit (sell half at +15%) arms a trailing stop, so the rest of the
  position can ride a runner instead of being capped at +15%.
- **Risk.** At most 5 open positions, 10 SOL starting capital, no shorts, no
  leverage. The bot never re-enters a coin it exited.

## Why this shape

On the 24h dev window (2–3 Nov 2026, 1,222 coins) every blind or momentum
rule loses: the median coin dumps ~−16% from launch to end of window, and the
pump is over within ~500 slots. The only profile near breakeven is a filtered
launch snipe with fast exits (the shipped sniper baseline: about −0.42 SOL,
guardrails met). Two tempting ideas were tested and rejected with data:

- Buying coins that already crossed 30 SOL of real reserves looks like +11.8 SOL
  if you price the buy at the crossing trade — but priced 2 slots later (the
  real fill latency) it is −6.3 SOL. The edge is a latency artifact.
- No launch feature predicts a migration (33% base rate; "hot" coins complete
  less often), so the bot does not chase completions.
- Letting winners run hurts: a partial take-profit + trailing stop scored
  −0.69 SOL vs −0.36 for the flat +15% exit. Runners reverse within slots.
- 26 parameter variants were swept on the dev window (tighter exits, trailing
  stops, stake 0.02–0.2 SOL, buyer caps 0–3, dev-buy caps). The monotone,
  structural finding: cleaner launches + smaller stakes + faster exits lose
  less. Final config (max 1 buyer, 0.02 SOL stake) scores **−0.074 SOL** on
  the dev window — still negative, as is every rule tested, including both
  shipped baselines. The final 6h window is fresh data; this config is the
  least-negative profile with the guardrails met by a wide margin (122 coins
  ≥ 0.01 SOL round trips, 0.9% max drawdown), so it is the best available
  ticket for a window that runs hotter than the dev one. Stricter variants
  that scored better (0 buyers, dev-buy ≤ 1 SOL) were rejected: they trade
  too few coins to clear the 20-coin guardrail on a 6h window.

## Files

- `main.ts` — the whole strategy (entrypoint, Node 22, no dependencies).
- `vendor/makefun-bot.ts` — the kit's bot shim, vendored unchanged.
- `LICENSE` — MIT. `.makefun/owner.json` — payout wallet.

## Verify locally

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot main.ts --driver process --worktree
```

Deterministic: every decision is a pure function of the `hello`/`batch`
stream, so two runs on the same data produce identical action logs.
