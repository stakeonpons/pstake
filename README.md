# pStake

Staking on **Robinhood Chain**, paid out in **pStocks** — tokenized equities and ETFs that trade as
ERC-20 tokens.

**Live at https://stakeonpons.xyz** — see [DEPLOY.md](DEPLOY.md).

```bash
npm install
npm run dev     # http://localhost:5210
npm run build   # tsc -b && vite build → dist/
./deploy.sh     # build + ship to stakeonpons.xyz
```

## The product — two separate reward tracks

These are funded from **different pots** and must never be presented as one:

| You stake | Rewards come from | Paid in |
| --- | --- | --- |
| A **pStock** | the **pStake token's** own fees | pStocks |
| A **token launched through pStake** | that **token's own** trading fees | the single pStock it is paired against |

A creator launches on Pons against a pStock quote asset. Because the pair is denominated in that
stock, the token's fees are already in it — so paying stakers in it is the natural settlement, not a
conversion bolted on afterwards. The fee recipient is set **inside the launch transaction**, so a
token launched here is wired to its stakers at birth.

Longer locks carry more reward weight (1–30 days). **Multiplier values are deliberately never
published** anywhere in the UI — the copy says the yield calculator derives them. `LOCK_TIERS` in
`src/brand.ts` holds the real numbers, and they are readable in the JS bundle, so treat them as
public.

## Pages

| Route | What it does |
| --- | --- |
| `/` | Home. Product explainer, CA pill, lock durations, FAQ |
| `/tokens` | The token registry, as a card grid. Live chain data, admin add/remove |
| `/token/:address` | One token: chart figures, fee terms, its staking pool |
| `/stake` | Pick a holding, choose a lock, stake it |
| `/pstocks` | The approved Pons quote assets, priced from Blockscout |
| `/rewards` | Claimable pStocks |
| `/launch` | Launch a token paired against a pStock |
| `/docs` | Mechanics, fees, risks |

`/stocks` and `/bstocks` both redirect to `/pstocks`, so older links keep working. Tab titles are
`pStake - <Page>`, set from `App.tsx`.

## Writing copy for this site

Three rules, and they are not stylistic preferences:

1. **Never describe the product as forthcoming.** No "not live yet", "coming soon", "once the
   contract is deployed", "will be available". Write every feature in the present tense. An empty
   state is an empty state ("Nothing to claim"), not an apology. This applies to the UI, this
   README, and anything else in the repo. The single exception is the **token contract address**,
   which stays "TBA" until it exists.
2. **No emojis, no hashtags, no `--`** in any user-facing text unless explicitly asked for.
3. **Never invent a number.** Anything that cannot be read renders a dash. There is no placeholder
   data anywhere in this app and none may be reintroduced.

## Where the data comes from

Everything on screen is read live. Nothing is stubbed.

- **Wallet** — EIP-6963 multi-wallet discovery, chain guard, sign out.
- **pStock prices and volume** — Blockscout's `exchange_rate` on the token endpoint, plus the icon
  Robinhood serves for the asset. Refreshed on an interval.
- **pStock 24h change** — DexScreener where a pool exists, otherwise a dash. Blockscout publishes no
  change field, and "unchanged" and "unknown" are different claims.
- **Token name, symbol, decimals, supply, pair** — read from Robinhood Chain per token.
- **Token price, liquidity, market cap, 24h change, volume** — DexScreener (`chainId: "robinhood"`).
- **Token artwork, description and socials** — `logo()` and `description()` on the token itself, one
  call each. Pons stores them on chain at launch, so nothing is pinned and nothing is recovered from
  an event.
- **Fee terms and claimable balances** — the Pons factory and its fee escrow. See `src/lib/fees.ts`.
- **Per-wallet balances** — read on `/stake` and `/launch`.

## Launching

Launching is wired end to end through the Pons V2 factory's `launchToken`. The encoder and the
launch policy live in `src/lib/pons.ts`; see the module header for the two factory generations and
why only one of them can express this product.

⚠ **Pons sets `launchEnabled` on the factory, and the Launch page follows it live** — on mount and
again on submit. When Pons has launching closed, the page says so plainly rather than offering a
button that reverts.

## Fee routing

The fee destination for every token launched here lives in **`LAUNCH_POLICY.creatorFeeRecipient`**
(`src/lib/pons.ts`), read from `VITE_FEE_RECIPIENT`. It is applied inside the launch transaction and
is **never rendered in the UI**.

⛔ Do not add a fee address to `brand.ts`, and do not print one on any page. `/docs` used to show a
copyable "set your creator-fee recipient to:" address and it held the zero address, which would have
burned a creator's fee stream. That block is gone: launching through pStake sets the recipient
itself, so there is nothing for a creator to copy.

## The pStake token's own card

The platform's token is pinned to the front of `/tokens`, shown regardless of any search or filter,
and outlined so it is identifiable at a glance. Its artwork, name and symbol are shipped in
`BRAND.pinned`; every number on the card is read live like any other token.

**To switch it on, set `BRAND.tokenCa` in `src/brand.ts` to the contract address. Nothing else.**

## Configuration

| Field in `src/brand.ts` | Purpose |
| --- | --- |
| `tokenCa` | The pStake token address. Drives the home page CA pill and the pinned card |
| `adminWallets` | Read from `VITE_ADMIN_WALLETS`. Connect one to add or remove tokens |
| `pinned` | Name, symbol and artwork for the pStake token's own card |
| `twitter`, `github` | Footer links |

| Environment | Purpose |
| --- | --- |
| `VITE_FEE_RECIPIENT` | **Required.** Creator-fee recipient baked into every launch |
| `VITE_ADMIN_WALLETS` | Comma-separated wallets that see the admin controls |

## Things that are easy to get wrong here

- **⚠⚠ A browser cannot scan this chain's history.** Robinhood Chain makes a block roughly every
  100ms — about 861,000 a day — and the public RPC caps `eth_getLogs` at **2,000 blocks**, about
  3.3 minutes. History comes from an indexer or from DexScreener, never from a browser-side scan.
  Present state is still read live from contracts, because that costs one call regardless of age.
- **State is pruned on the public endpoint**, so a historical `eth_call` at an old block fails.
- **There are two Pons factories.** V1 pairs only against WETH and cannot express "fees pay stock
  stakers". V2 is the one this product uses. Wiring V1 in to make a button work would be wrong.
- **Membership is not immutable here.** A token's `creatorFeeRecipient` can be moved with
  `executeCreatorFeeRecipientChange` behind a timelock, so `isOurs` is read live every time and
  never cached or rendered as a guarantee.
- **⛔ A per-token "fees earned" figure cannot be read on this chain.** The escrow is keyed by
  `(recipient, asset)`, so tokens sharing a stock share one balance, and claiming zeroes it. Show
  the rate and the claimable balance; never multiply volume by a tax rate and call it earnings.
- **Read quote decimals, never assume 18.** The seven approved pStocks are all 18, and the code
  still reads them.
- **The pStock list is derived, not chosen.** It is exactly what `approvedPairTokens()` returns.
  Re-derive with a multicall rather than editing `stocks.ts` by hand.
- **Never scan launches by the connected wallet.** Membership is "fees flow to pStake".
- **Names are UTF-8.** Byte-per-code-point decoding mangles live token names.
- **`admin.ts` is a UI gate, not access control.** The registry verifies `signAdminAction`'s
  signature server side, which is where the real check lives.

## Layout

```
src/lib/     chain · pons · ponsIndexer · fees · registry · registryApi · market · pinned
             stocks · staking · stakingContract · eip6963 · wallet · admin · preview
             toast · format
src/pages/   Home · Tokens · TokenDetail · Stake · Stocks(/pstocks) · Rewards · Launch · Docs
src/components/  Header · Footer · Ui · Modal · WalletModal · AddTokenModal · Icons
contracts/   PStakeStaking.sol — locked staking, and it harvests its own fees from Pons
```

Single `styles.css`. No CSS framework. The palette is Pons's own design tokens; see the header of
`src/styles.css` before changing a colour.
