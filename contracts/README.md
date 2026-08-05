# Stake staking contracts

```bash
forge build
forge test
```

`PStakeStaking.sol` — locked staking, one contract, many pools, and it collects its own revenue.

## Both reward tracks, one primitive

A pool is `(stakeToken, rewardToken)`. That is enough for both, and nothing in the contract needs to
know which product a pool belongs to — which is what stops the two drifting apart:

| Product | Pool |
| --- | --- |
| A token launched through Stake | stake that token, reward its paired stock |
| The Stake token | stake a stock, reward a stock |

Lock terms of 1, 3, 7, 14, 21 and 30 days carry weight multipliers. Rewards accrue on weight, are
claimable at any time including during a lock, and principal is returned only after the term. There
is no early exit, with or without penalty — a penalty is an early exit with extra steps, and the
multiplier only means something if the commitment is real.

## Fees arrive without a keeper

Pons credits creator fees to an escrow keyed by `(recipient, asset)` and lets the recipient claim
for itself. So this contract can be named as a token's `creatorFeeRecipient`, and `harvest(asset)` —
which **anybody** may call — pulls the fees out of the escrow and into the pools. Stakers never wait
on an operator, and no wallet custodies the money on the way.

## ⚠⚠ The escrow merges tokens that share a stock, so the split is a declaration

The escrow key is `(recipient, asset)`, not `(recipient, token, asset)`. Two tokens paired against
the same stock credit **one indivisible balance**, and the chain retains nothing saying which token
earned what.

`setSplit` therefore does not discover the division, it declares one, and `harvest` follows it. With
one pool per stock the declaration is exact. What it can check, it does: every pool named must
actually pay out in that asset, no pool may appear twice, and the shares must total exactly 100%.

Do not add a heuristic that infers the division from volume, supply or curve state. Any such
estimate drifts from the truth the moment anything is claimed, and it would be paying real stakers
on a guess while looking like a measurement.

## Things that will bite you if changed

- **`balanceOf` is never used for accounting.** `stakeToken` and `rewardToken` may be the same asset
  — staking NVDA to earn NVDA is an intended configuration — so inferring rewards from a balance
  would pay principal out as reward.
- **Inbound amounts are measured by balance delta**, so an asset that takes a cut of transfers
  credits what arrived. Crediting the request would over-credit stakers and leave the last one out
  unable to withdraw.
- **`weight * accPerWeight` uses `Math.mulDiv`.** A plain multiply overflows when a pool is funded
  while its total weight is tiny, and because that multiplication sits inside `_pending`, the revert
  reaches `stake`, `claim` and `withdraw` alike — nobody could enter and nobody already in could
  leave. Never reduce `_weighted()` to a plain multiply.
- **Rounding always favours the pool.** Truncating divisions leave a few wei behind at both the
  split level and the claim level. Rounding up would pay out more than came in.
- **Rewards credited to an empty pool are queued**, not dropped, and settle into the next credit.
- **`minStake` is load-bearing.** Rewards are paid on arrival and `harvest` is public, so without a
  floor one wei staked into an empty pool immediately before a harvest collects the entire claimable
  balance. The floor prices that instead of pretending it is gone.
- **`harvest` refuses before it claims** when no split is declared. Fees left in the escrow are still
  owed to the contract; fees claimed with nowhere to send them would be stuck, because there is
  deliberately **no ERC-20 rescue** — every token held is principal or credited rewards.

## Tests

`forge test` covers the happy path plus a hostile pass, including the cases that model real losses:
a same-asset pool proving principal is never paid out as reward, a taxed token proving the contract
stays solvent, the accumulator overflow above, and fuzzed solvency properties asserting a pool never
pays out more than was deposited and a harvest never distributes more than the escrow delivered.

A separate fork suite runs against the real deployed assets and the real fee escrow, which is where
the surprises live — above all whether the escrow will pay a contract at all.
