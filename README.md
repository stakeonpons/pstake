# Stake

Staking on **Robinhood Chain**, paid out in **stocks** — tokenized equities and ETFs that trade as
ERC-20 tokens.

**Live at [stakeonpons.xyz](https://stakeonpons.xyz)**

| | |
| --- | --- |
| $STAKE | `0x831758E8C9C043bE7DEB4D74a4Cf581599aeffe5` |
| Staking | `0x730465263fFaA2855fF3614C93C486038dE41ed6` |
| Chain | Robinhood Chain (4663) |

```bash
npm install
cp .env.example .env.local     # fill in the values
npm run dev                    # http://localhost:5210
npm run build
```

## Reward tracks, funded from different pots

These are never presented as one, because the source of the money and therefore the risk differ:

| You stake | Rewards come from | Paid in |
| --- | --- | --- |
| **$STAKE** | $STAKE's own trading fees | $STAKE |
| A **stock** | the **Stake token's** fees | stocks |
| A **token launched through Stake** | that **token's own** trading fees | stocks |

The fee wallet is set **inside the launch transaction**, so a token launched here is wired to its
stakers at birth with no second step and nothing for a creator to configure.

Longer locks carry more reward weight, from one day to thirty. Rewards are claimable during a lock;
principal returns when the term ends.

### Where the money actually arrives

Launches go through Pons **V1**, which pairs every token against **WETH** — the pair is fixed by the
launch config, not chosen per launch. So a token's fees accrue in WETH and in the token itself, and
the stock a creator picks is recorded by Stake rather than enforced by the pool. Paying stock
stakers is therefore a conversion Stake performs, not a property of the pair.

Fees are collected from the launch locker and paid into pools with `depositRewards`. $STAKE's own
fees are already denominated in $STAKE, which is what the $STAKE pool distributes.

## Pages

| Route | |
| --- | --- |
| `/` | Product explainer, lock durations, FAQ |
| `/tokens` | The token registry as a card grid, with live chain data |
| `/token/:address` | Per-token dashboard: market cap, fee terms, staking |
| `/stake` | Pick a holding, choose a lock, stake it |
| `/stocks` | The approved Pons quote assets and their live prices |
| `/rewards` | Claimable stocks |
| `/launch` | Launch a token paired against a stock |
| `/docs` | Mechanics, fees, risks |

## Where the data comes from

Everything on screen is read live. Nothing is stubbed, and there is no placeholder data anywhere in
this repository.

- **Wallet** — EIP-6963 multi-wallet discovery, chain guard, sign out.
- **Stock prices and volume** — Blockscout's `exchange_rate`, plus the icon Robinhood serves for
  the asset.
- **Stock 24h change** — DexScreener where a pool exists, otherwise a dash. Blockscout publishes no
  change field, and "unchanged" and "unknown" are different claims.
- **Token name, symbol, decimals, supply, pair** — read from Robinhood Chain per token.
- **Token price, liquidity, market cap, 24h change, volume** — DexScreener.
- **Token artwork, description and socials** — `logo()` and `description()` on the token itself. Pons
  stores them on chain at launch, so nothing is pinned and nothing is recovered from an event.
- **Fee terms and claimable balances** — the Pons factory and its fee escrow.
- **Fees a token has collected to date** — summed from the launch locker's `FeesClaimed` events via
  Blockscout. Nothing on chain stores a lifetime total: collecting transfers and zeroes, and this
  chain's log cap rules out sweeping the history from a browser.
- **Staking positions, pool totals and pending rewards** — read from the staking contract.

**A value that cannot be read renders a dash.** Never a zero, never a guess.

## Contracts

`contracts/` holds the staking contract and its tests.

```bash
cd contracts && forge test                                   # the off-chain suite
forge test --match-path 'test/{Fork,StakePool,LaunchV1,DevBuy,LiveStake}.t.sol' --fork-url rhc
```

The second line is not optional coverage. Those suites drive the **real** factories, locker, router
and token on a fork of Robinhood Chain, which is the only way to check behaviour that no mock can
tell you: that a fee wallet really is honoured, that an initial buy really does pay the wrong party,
that a swap in the launch block really does fail. They fail when run without a fork, by design.

A pool is `(stakeToken, rewardToken)`, which is enough to express both reward tracks — so nothing in
the contract needs to know which product a pool belongs to. Lock terms carry weight multipliers,
rewards accrue on weight and are claimable during a lock, and principal is returned only after the
term. There is no early exit, with or without penalty.

Pools are funded two ways, and which one applies depends on where a token's fees accrue:

- **`depositRewards`** — an allowlisted wallet pays collected fees into a pool. This is how the
  $STAKE pool is funded, because V1 fees accrue in a locked liquidity position rather than in a fee
  escrow the contract can pull from itself.
- **`harvest`** — anybody may call it. The contract can be named a token's creator-fee recipient, and
  this pulls those fees out of the Pons **V2** escrow into the pools with no keeper and no wallet
  holding stakers' money on the way. It refuses when no split is declared, so fees are never claimed
  with nowhere to go.

A pool whose stake asset and reward asset are the same token holds principal and rewards in one
balance. Payouts come from the reward accumulator and never from the contract's balance, which is
what stops one staker's claim being funded out of another's deposit. The tests assert that property
directly rather than the mechanism.

## Things that are easy to get wrong here

Each of these cost real debugging time:

- **⚠⚠ A browser cannot scan this chain's history.** Robinhood Chain makes a block roughly every
  100ms — about 861,000 a day — and the public RPC caps `eth_getLogs` at **2,000 blocks**, about
  3.3 minutes of history. History comes from an indexer or from DexScreener, never from a
  browser-side scan. Present state is still read live from contracts, because that costs one call
  regardless of how old the chain is.
- **State is pruned on the public endpoint**, so a historical `eth_call` at an old block fails.
- **There are several Pons factory generations and they are not interchangeable.** V1 pairs only
  against WETH and keeps fee routing in a **locker**; V2 pairs against an approved stock and keeps it
  on the **factory record**. Reading one generation's field on the other reports nothing and looks
  identical to "no fees". Check which factory launched a token before trusting an ABI.
- **A V1 fee redirect is an override, not the destination.** It is the zero address unless somebody
  set one, and the default recipient is the deployer. Reading only the redirect reports "no fee
  wallet" for most tokens.
- **A V1 initial buy pays the fee wallet, not the buyer.** Harmless when they are the same person and
  a way to take a creator's money when they are not, so a buy is made as a separate swap from the
  creator's own wallet instead.
- **A swap in the launch block always fails**, at any size, because the token blocks transfers until
  its restriction window closes. Uniswap reports it as a transfer failure, which says nothing about
  the real cause.
- **A token's fee recipient is not immutable.** It can be moved behind a timelock, so "does this
  token pay Stake" is read live every time and never cached or presented as a guarantee.
- **A per-token "fees earned" figure cannot be read on this chain.** The fee escrow is keyed by
  `(recipient, asset)`, so two tokens paired against the same stock credit one shared balance, and
  claiming zeroes it. Show the rate and the claimable balance; do not multiply volume by a rate and
  call the result earnings.
- **Read quote decimals, never assume 18**, even when every asset currently is.
- **The quote-asset list is derived, not chosen.** It is exactly what the factory's
  `approvedPairTokens` returns. A hand-written list was wrong once and nothing in the UI could
  reveal it.
- **Addresses are normalised before validation.** `isAddress` enforces the EIP-55 checksum, so a
  valid address in the wrong case would otherwise be rejected as malformed.
- **Names are UTF-8.** Byte-per-code-point decoding mangles a meaningful share of live token names.

## Layout

```
src/lib/         chain · pons · ponsV1 · launchPolicy · ponsIndexer · fees · registry
                 registryApi · market · pinned · staking · stakingContract · stocks
                 eip6963 · wallet · toast · format
src/pages/       Home · Tokens · TokenDetail · Stake · Stocks · Rewards · Launch · Docs
src/components/  Header · Footer · Ui · Modal · WalletModal · Icons
contracts/       PStakeStaking.sol and its tests
```

Single `styles.css`. No CSS framework.

## Licence

MIT.
