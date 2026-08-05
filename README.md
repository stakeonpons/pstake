# Stake

Staking on **Robinhood Chain**, paid out in **stocks** — tokenized equities and ETFs that trade as
ERC-20 tokens.

**Live at [stakeonpons.xyz](https://stakeonpons.xyz)**

```bash
npm install
cp .env.example .env.local     # fill in the values
npm run dev                    # http://localhost:5210
npm run build
```

## Two reward tracks, funded from different pots

These are never presented as one, because the source of the money and therefore the risk differ:

| You stake | Rewards come from | Paid in |
| --- | --- | --- |
| A **stock** | the **Stake token's** own fees | stocks |
| A **token launched through Stake** | that **token's own** trading fees | the single stock it is paired against |

A creator launches on Pons against a stock quote asset. Because the pair is denominated in that
stock, the token's fees are already in it, so paying stakers in it is the natural settlement rather
than a conversion bolted on afterwards. The fee recipient is set **inside the launch transaction**,
which means a token launched here is wired to its stakers at birth.

Longer locks carry more reward weight, from one day to thirty.

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

**A value that cannot be read renders a dash.** Never a zero, never a guess.

## Contracts

`contracts/` holds the staking contract and its tests.

```bash
cd contracts && forge test
```

A pool is `(stakeToken, rewardToken)`, which is enough to express both reward tracks — so nothing in
the contract needs to know which product a pool belongs to. Lock terms carry weight multipliers,
rewards accrue on weight and are claimable during a lock, and principal is returned only after the
term. There is no early exit, with or without penalty.

The contract collects its own revenue: it can be named as a token's creator-fee recipient, and
`harvest` — which anybody may call — pulls those fees out of the Pons fee escrow and into the pools.
No keeper, and no wallet holding stakers' money on the way.

## Things that are easy to get wrong here

Each of these cost real debugging time:

- **⚠⚠ A browser cannot scan this chain's history.** Robinhood Chain makes a block roughly every
  100ms — about 861,000 a day — and the public RPC caps `eth_getLogs` at **2,000 blocks**, about
  3.3 minutes of history. History comes from an indexer or from DexScreener, never from a
  browser-side scan. Present state is still read live from contracts, because that costs one call
  regardless of how old the chain is.
- **State is pruned on the public endpoint**, so a historical `eth_call` at an old block fails.
- **There are two Pons factory generations, and they are not interchangeable.** One pairs only
  against WETH, which cannot express "a token's fees pay the stakers of the stock it is paired
  against". Check which one you are reading before trusting an ABI.
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
src/lib/         chain · pons · ponsIndexer · fees · registry · registryApi · market
                 pinned · staking · stakingContract · stocks · eip6963 · wallet · toast · format
src/pages/       Home · Tokens · TokenDetail · Stake · Stocks · Rewards · Launch · Docs
src/components/  Header · Footer · Ui · Modal · WalletModal · Icons
contracts/       PStakeStaking.sol and its tests
```

Single `styles.css`. No CSS framework.

## Licence

MIT.
