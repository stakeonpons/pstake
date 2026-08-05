# bStake staking contracts

```bash
forge build
forge test
```

`BStakeStaking.sol` — locked staking, one contract, many pools.

## Both reward tracks, one primitive

A pool is `(stakeToken, rewardToken)`. That is enough for both, and nothing in the contract needs to
know which product a pool belongs to — which is what stops the two drifting apart:

| Product | Pool |
| --- | --- |
| A token launched through bStake | stake that token, reward its paired bStock |
| The bStake token | stake a bStock, reward a bStock |

Lock terms of 1, 3, 7, 14, 21 and 30 days carry weight multipliers. Rewards accrue on weight, are
claimable at any time including during a lock, and principal is returned only after the term. There
is no early exit, with or without penalty — a penalty is an early exit with extra steps, and the
multiplier only means something if the commitment is real.

## Things that will bite you if changed

- **`balanceOf` is never used for accounting.** `stakeToken` and `rewardToken` may be the same asset
  — staking NVDAB to earn NVDAB is an intended configuration — so inferring rewards from a balance
  would pay principal out as reward.
- **Inbound amounts are measured by balance delta.** Launched tokens carry a transfer tax, so what
  arrives is less than what was asked for. Crediting the request would over-credit stakers and leave
  the last one out unable to withdraw.
- **`weight * accPerWeight` uses `Math.mulDiv`.** A plain multiply overflows when a pool is funded
  while its total weight is tiny, and because that multiplication sits inside `_pending`, the revert
  reaches `stake`, `claim` and `withdraw` alike — nobody could enter and nobody already in could
  leave. Never reduce `_weighted()` to a plain multiply.
- **Rounding always favours the pool.** Two truncating divisions leave a few wei per claim behind.
  Rounding up instead would pay out more than came in.
- **Rewards deposited into an empty pool are queued**, not dropped, and settle into the next deposit.

## Tests

`forge test` covers the happy path plus a hostile pass, including the cases that model real losses:
a same-asset pool proving principal is never paid out as reward, a taxed token proving the contract
stays solvent, the accumulator overflow above, and a fuzzed solvency property asserting a pool never
pays out more than was deposited.
