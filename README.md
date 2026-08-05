# bStake

Staking on BNB Chain, paid out in **bStocks** — tokenized equities, ETFs and gold that trade as
BEP-20 tokens.

**Live at [bstake.sh](https://bstake.sh)**

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
| A **bStock** | the **bStake token's** own fees | bStocks |
| A **token launched through bStake** | that **token's own** trading fees | the single bStock it is paired against |

A creator launches on flap.sh against a bStock quote asset. Because the pair is denominated in that
stock, the token's fees are already in it, so paying stakers in it is the natural settlement rather
than a conversion bolted on afterwards. The fee beneficiary is set **inside the launch
transaction**, which means a token launched here is wired to its stakers at birth.

Longer locks carry more reward weight, from one day to thirty.

## Pages

| Route | |
| --- | --- |
| `/` | Product explainer, lock durations, FAQ |
| `/tokens` | The token registry as a card grid, with live chain data |
| `/token/:address` | Per-token dashboard: market cap, fees, staking, recent trades |
| `/stake` | Pick a holding, choose a lock, stake it |
| `/bstocks` | The flap quote assets, priced from Binance |
| `/rewards` | Claimable bStocks |
| `/launch` | Launch a token paired against a bStock |
| `/docs` | Mechanics, fees, risks |

## Where the data comes from

Everything on screen is read live. Nothing is stubbed, and there is no placeholder data anywhere in
this repository.

- **Wallet** — EIP-6963 multi-wallet discovery, chain guard, sign out.
- **bStock prices, 24h change, volume** — `api.binance.com`, refreshed every 30s.
- **Token name, symbol, decimals, supply, pair, price, liquidity, market cap** — read from BNB
  Chain per token. Price and liquidity come from the token's own pair, whether it is quoted in BNB
  or in a bStock, converted at that asset's live price.
- **24h change, volume, age** — DexScreener, which indexes flap.sh.
- **Fees earned per token** — flap's Tax Token Helper, which keeps a cumulative total per token, so
  this is measured rather than estimated from volume.
- **Token artwork and socials** — the token's own metadata document, recovered from its launch
  event. See `src/lib/tokenMeta.ts`.

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

## Things that are easy to get wrong here

Each of these cost real debugging time:

- **Pair discovery must try both factories, every quote asset, and pick the deepest pair.** A token
  paired against a bStock has no WBNB pair, and a token that graduates off the flap curve moves to
  PancakeSwap V2, leaving its flap pair at zero reserves. Returning the first pair that exists
  reports the successful tokens as dead.
- **Read quote decimals, never assume 18.** XAUT is 6.
- **The launch event's topic0 matches around thirty times too much.** Filter on one topic plus at
  least 448 bytes of data.
- **A token's launch salt must produce an address ending in `7777`.** The Portal enforces it.
- **DexScreener's `priceChange` is base-side only.** flap sometimes makes the bStock the base token,
  and reading that pair's change prints an unrelated asset's move under your token's name.
- **Locating a block by timestamp needs a bracket that grows.** Extrapolating from an assumed block
  time and bisecting a fixed window silently returns the wrong block as the gap widens.
- **Addresses are normalised before validation.** `isAddress` enforces the EIP-55 checksum, so a
  valid address in the wrong case would otherwise be rejected as malformed.
- **Names are UTF-8.** Byte-per-code-point decoding mangles a meaningful share of live token names.

## Layout

```
src/lib/         chain · flapIndexer · registry · registryApi · market · tokenMeta · tax
                 pinned · staking · stocks · flap · ipfs · eip6963 · wallet · toast · format
src/pages/       Home · Tokens · TokenDetail · Stake · Stocks · Rewards · Launch · Docs
src/components/  Header · Footer · Ui · Modal · WalletModal · Icons
contracts/       BStakeStaking.sol and its tests
```

Single `styles.css`. No CSS framework.

## Licence

MIT.
