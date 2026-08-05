# pStake staking contracts

```bash
forge build
forge test                                          # 46 tests, no network
forge test --match-path test/Fork.t.sol --fork-url rhc   # 4 more, against real Pons
```

`PStakeStaking.sol` — locked staking on Pons / Robinhood Chain. One contract, many pools, and fees
it collects itself.

## Both products, one primitive

A pool is `(stakeToken, rewardToken)`. That is enough for both models, and nothing in the contract
needs to know which product a pool belongs to — which is what stops the two drifting apart:

| Product | Pool |
| --- | --- |
| A token launched through pStake | stake that token, reward its paired pStock |
| The pStake token | stake a pStock, reward a pStock. **pStake itself is never staked** |

Lock terms 1/3/7/14/21/30 days carry weight multipliers 1x to 3x. Rewards accrue on weight, are
claimable at any time including during a lock, and principal is returned only after the term. There
is no early exit, with or without penalty.

## ⭐ Why the contract collects its own revenue

A launchpad that **pushes** fees to a fixed wallet forces a person or a keeper to move money into
the pools every time. Pons instead credits a **fee escrow** keyed by `(recipient, asset)` and lets
the recipient claim for itself.

So this contract can be named `creatorFeeRecipient` at launch, and `harvest(stock)` — which
**anybody** may call — pulls the fees out of the escrow and into the pools. No keeper, and no wallet
ever custodies fees on their way to stakers.

**Verified against the real deployed escrow**, not a mock: `test_harvest_realEscrowPaysAContract` in
`test/Fork.t.sol` credits the staking contract through Pons's own permissionless `creditToken` and
then harvests it from an address with no privileges at all. The escrow transfers to a contract
exactly as it does to a wallet. That was the load-bearing assumption of this whole design.

## ⚠⚠ The escrow merges tokens that share a stock, so `setSplit` is a DECLARATION

The escrow key is `(recipient, asset)` — **not** `(recipient, token, asset)`. Pons's own comment on
it: *"A recipient's balance aggregates credits from every launch, curve, hook and buyback release."*

So when two pStake tokens are both paired against NVDA and both name this contract, their fees
arrive as **one indivisible NVDA balance** and the chain retains nothing saying which token earned
what. `setSplit` does not discover the division, it declares one on the operator's authority, and
`harvest` follows it.

With one token per stock the declaration is exact (a single share at 100%, which is what `Deploy.s.sol`
writes) and the caveat is theoretical. From the second token paired against the same stock onward, it
is a judgement call no amount of reading the chain can check.

⛔ Do not add a heuristic that infers the division from volume, supply or curve state. Every such
estimate drifts from the truth the moment anything is claimed or routed elsewhere, and it would be
paying real stakers on a guess while looking like a measurement.

What `setSplit` *can* check, it does, because each of these silently misroutes real money: every pool
named must actually pay out in that asset, no pool may appear twice, and the shares must total
exactly 100%.

## Things that will bite you if changed

- **`balanceOf` is never used for accounting.** `stakeToken` and `rewardToken` may be the same asset
  (stake NVDA, earn NVDA), so inferring rewards from a balance would pay principal out as reward.
- **Inbound amounts are measured by balance delta**, so an asset that takes a cut of transfers
  credits what arrived. Crediting the request would over-credit stakers and leave the last one out
  unable to withdraw.
- **Rounding always favours the pool.** Truncating divisions leave a few wei behind, at both the
  split level (`residual`) and the claim level. Rounding up would pay out more than came in.
- **Rewards credited to an empty pool are queued**, not dropped, and settle into the next credit.
- **Harvest refuses before it claims** when no split is declared. Fees left in the escrow are still
  owed to this contract; fees claimed with nowhere to send them would be stuck, since there is
  deliberately **no ERC-20 rescue** — every token here is somebody's principal or credited rewards.
- **`rescueNative` is native-only, on purpose.** Native is the one asset that can never belong to a
  pool. An ERC-20 equivalent would be a licence to take stakers' money.
- **Rewards are paid on arrival, not streamed** — the operator's decision, so fees are distributed
  whenever they are available. The tradeoff is documented on `depositRewards`.

## ⚠⚠ `minStake` is what makes a permissionless harvest safe

Paying on arrival means whoever holds weight at the instant of a credit takes a full share of it.
When only the operator can fund a pool, the operator chooses that instant. **With `harvest` public,
the attacker chooses it** — so without a floor, one wei staked into an empty pool followed by a
harvest in the same transaction collects the entire claimable balance.

`Pool.minStake` prices that: entering costs real capital locked for a real term, on the same terms as
everyone else. It does not eliminate the timing advantage, it makes it not free. `Deploy.s.sol` sets
1e18 — one whole share, since all seven pStocks are 18 decimals. Zero is permitted for a pool whose
reward asset has no fee route, and should not be the default choice.

## Adversarial review, 5 Aug 2026

The happy-path suite was written by whoever wrote the contract, so a second hostile pass went
looking for what it was not designed to catch. It found one bug that would have been unrecoverable.

### FIXED: an accumulator overflow could brick a pool permanently

`accPerWeight` grows by `credit * PRECISION / totalWeight`, so funding a pool while its total weight
is tiny — one dust position, or the moment after everyone withdrew — inflates it enormously. A
normal-sized position multiplied by that inflated accumulator exceeded 2^256 and reverted.

That is not a failed transaction. The multiplication sits inside `_pending`, which `stake`, `claim`
and `withdraw` all reach, so **nobody could enter the pool and nobody already in could leave**. It
needed no attacker: an ordinary deposit into a nearly-empty pool was enough.

Fixed with `Math.mulDiv`, which carries the full 512-bit product. Both cases are pinned by
`test/Adversarial.t.sol`.

### MITIGATED, not eliminated: dust captures a credit

Previously open, and made sharper by a permissionless `harvest` — see `minStake` above.

### Checked and sound

Duplicate ids in `claimMany` pay once · a position cannot be claimed by another user · a withdrawn
position never earns again · reentrancy is guarded on every external mutator · principal is exact
even when rewards round · a harvest of the same asset a pool is staked in never touches principal.

## Tests

**46 off-chain, 4 on a fork of Robinhood Chain.**

The unit suite proves the arithmetic against mocks it fully controls, including the two that model
real losses: a same-asset pool proving principal is never paid out as reward, and a taxed token
proving the contract stays solvent. Two fuzzed properties pin solvency — the pool never pays out more
than was deposited, and a harvest never distributes more than the escrow delivered.

The fork suite proves the contract against the actual deployed bytecode of the assets it will hold
and the escrow it will pull from, which is where the surprises live: a proxy, a non-standard return
value, a transfer hook, and above all whether the escrow will pay a contract at all.

⚠ `test/mocks/Escrow.sol` is written against the escrow's **verified source**, not its ABI, because
the two behaviours that matter are invisible in a signature: `claimToken` **reverts** on a zero
balance rather than returning zero, and `creditToken` is permissionless and credits the balance
delta.

⚠ The fork suite pins no block number, deliberately — the public RPC prunes state and Robinhood Chain
makes a block roughly every 100ms, so a pinned block stops working within minutes.
