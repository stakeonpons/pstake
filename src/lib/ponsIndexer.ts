/**
 * Reads Pons launches and token state off Robinhood Chain.
 *
 * ## ⚠⚠ Where the numbers come from changed with the chain, and it is not a downgrade in rigour
 *
 * On BNB this module derived price and liquidity from a V2 pair's `getReserves()`, and found a
 * token's launch by scanning logs. **Neither is possible here:**
 *
 *  - **There is no pair contract.** Pons V2 trades on a bonding curve and graduates into a
 *    **Uniswap V4 singleton**, which holds every pool in one contract with no per-pool address and
 *    no reserves to read. Price lives in a packed `slot0` reachable only by `extsload` of a
 *    computed pool id.
 *  - **A browser cannot scan.** Robinhood Chain makes a block every ~100ms and the public RPC caps
 *    `eth_getLogs` at 2,000 blocks — about 3.3 minutes. `scanLaunches()` and the launch-event
 *    decoder that existed here for pons are gone, deliberately, rather than left to fail quietly.
 *
 * So: **identity, pairing, fee routing and phase are read from contracts** — the facts that decide
 * where money goes — while **price, liquidity and market cap come from DexScreener**, which indexes
 * this chain (`chainId: "robinhood"`, both v3 and v4 pools). Prices are converted back into the
 * paired stock's units so every downstream calculation is unchanged from the BNB build.
 *
 * A token DexScreener has not indexed yet renders dashes for those three and fills in on its own.
 * Nothing is invented to cover the gap.
 */

import { erc20Abi, getAddress, parseAbi, type Address } from 'viem'
import { publicClient } from './chain'
import { PONS, FACTORY_ABI } from './pons'
import { STOCKS, stockByAddress } from './stocks'
import { fetchMarketExtras, type MarketExtras } from './market'
import { BLOCKSCOUT } from './chain'

export type PairInfo = {
  /** The curve contract — the closest thing V2 has to a pair address. Null before graduation. */
  pair: Address | null
  /** stock ticker the token is paired against, or null when it is not paired against a stock. */
  quoteTicker: string | null
}

export type OnChainToken = {
  address: Address
  name: string
  symbol: string
  decimals: number
  totalSupply: bigint
  /** Curve address, used for links and for reading graduation state. */
  pair: Address | null
  quoteTicker: string | null
  /** Price in units of the paired stock per token. */
  priceQuote: number | null
  /** Liquidity expressed in the paired stock's units. */
  liquidityQuote: number | null
  /** ⭐ Who the token's creator fees pay. This is what identifies a token as one of ours. */
  creatorFeeRecipient: Address | null
  /** Creator tax in bps, as set at launch. Null when the factory does not know the token. */
  creatorTaxBps: number | null
  /** Pons lifecycle phase. 0 is the curve; a graduated token has moved to the V4 pool. */
  phase: number | null
}

/** Reads ERC-20 metadata. Batched into one multicall by the client. */
export async function readTokenMeta(address: Address) {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'name' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }),
  ])
  return { name, symbol, decimals, totalSupply }
}

const TOKEN_ABI = parseAbi([
  'function logo() view returns (string)',
  'function description() view returns (string)',
])

/**
 * The token's own artwork and description.
 *
 * ⭐ On Pons these are **plain on-chain strings set at launch** — one call each, forever. The pons
 * build needed an IPFS pin, the launch event, an archive node and a timestamp-to-block bisection to
 * recover the same thing, and it broke whenever any of those degraded.
 */
export async function readTokenArt(address: Address): Promise<{ logo: string | null; description: string | null }> {
  const [logo, description] = await Promise.all([
    publicClient.readContract({ address, abi: TOKEN_ABI, functionName: 'logo' }).catch(() => ''),
    publicClient.readContract({ address, abi: TOKEN_ABI, functionName: 'description' }).catch(() => ''),
  ])
  return { logo: (logo as string) || null, description: (description as string) || null }
}

/**
 * The launch record: pairing, fee routing, tax and phase.
 *
 * Returns null when the factory reports `exists = false`, which is the honest answer for any token
 * not launched on Pons V2 — including every V1 token.
 */
export async function readLaunch(address: Address) {
  try {
    const info = await publicClient.readContract({
      address: PONS.factory as Address,
      abi: FACTORY_ABI,
      functionName: 'getLaunchedToken',
      args: [address],
    })
    if (!info.exists) return null
    return {
      curve: info.curve,
      deployer: info.deployer,
      creatorFeeRecipient: info.creatorFeeRecipient,
      pairToken: info.pairToken,
      creatorTaxBps: Number(info.creatorTaxBps),
      phase: Number(info.phase),
      buybackEnabled: info.buybackEnabled,
    }
  } catch {
    return null
  }
}

/**
 * Which stock a token is paired against.
 *
 * ⭐ Read from the factory, not searched for. On BNB this needed a multicall across two factories
 * and every candidate quote asset, because nothing recorded the pairing; Pons stores it.
 */
export async function findPair(token: Address): Promise<PairInfo | null> {
  const launch = await readLaunch(token)
  if (!launch) return null
  return {
    pair: launch.curve && launch.curve !== ZERO ? getAddress(launch.curve) : null,
    quoteTicker: stockByAddress(launch.pairToken)?.ticker ?? null,
  }
}

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Everything one token page and one card need.
 *
 * ⚠ `priceQuote` is USD-from-DexScreener divided back into the paired stock's own price, so the
 * downstream USD conversion (`priceQuote × stock price`) is arithmetically identical to reading a
 * pool. Doing it this way keeps one conversion path for every token rather than two that can drift.
 */
export async function readToken(address: Address): Promise<OnChainToken> {
  const [meta, launch, extras] = await Promise.all([
    readTokenMeta(address),
    readLaunch(address),
    fetchMarketExtras([address]).catch(() => ({}) as Record<string, MarketExtras>),
  ])

  const stock = launch ? stockByAddress(launch.pairToken) : undefined
  const market: MarketExtras | undefined = extras[address.toLowerCase()]

  /**
   * `priceNative` IS the old `priceQuote`: the token's price in units of whatever it is paired
   * against. Taking it directly avoids a second conversion path that could drift from the first.
   *
   * Liquidity is converted through the token's own two prices — `liquidityUsd / priceUsd` gives
   * the pool's size in token units, and multiplying by `priceNative` restates it in the stock's
   * units — so it needs no third source and cannot disagree with the price shown beside it.
   */
  const market2 = market ?? null
  const priceQuote = stock ? (market2?.priceNative ?? null) : null
  const liquidityQuote =
    stock && market2?.liquidityUsd != null && market2.priceUsd != null && market2.priceNative != null
      ? (market2.liquidityUsd / market2.priceUsd) * market2.priceNative
      : null

  return {
    address,
    ...meta,
    pair: launch?.curve && launch.curve !== ZERO ? getAddress(launch.curve) : null,
    quoteTicker: stock?.ticker ?? null,
    priceQuote,
    liquidityQuote,
    creatorFeeRecipient: launch ? getAddress(launch.creatorFeeRecipient) : null,
    creatorTaxBps: launch?.creatorTaxBps ?? null,
    phase: launch?.phase ?? null,
  }
}

/**
 * Reads an owner's balance of several tokens at once.
 *
 * Raw base units keyed by lowercased address; a token that fails to read is absent rather than
 * reported as zero, so "could not read" is never mistaken for "you hold none".
 */
export async function readBalances(
  owner: Address,
  tokens: readonly Address[],
): Promise<Record<string, bigint>> {
  const results = await Promise.all(
    tokens.map((t) =>
      publicClient
        .readContract({ address: t, abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
        .then((v) => [t, v as bigint] as const)
        .catch(() => null),
    ),
  )
  const out: Record<string, bigint> = {}
  for (const r of results) if (r) out[r[0].toLowerCase()] = r[1]
  return out
}

/**
 * Pulls the new token address out of a confirmed launch receipt.
 *
 * `TokenLaunched(address token, address curve, address deployer, ...)` indexes the token, so it is
 * topic 1 — no data decoding and no shape gate, unlike pons's untyped 448-byte payload.
 */
const TOKEN_LAUNCHED_TOPIC0 = '0x' as string

export function tokenFromReceipt(receipt: {
  logs: readonly { address: string; topics: readonly string[] }[]
}): Address | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== PONS.factory.toLowerCase()) continue
    // Three indexed args plus the signature: token is the first, and it is the only launch event
    // this factory emits with that shape.
    if (log.topics.length !== 4) continue
    const topic = log.topics[1]
    if (!topic) continue
    try {
      return getAddress(`0x${topic.slice(26)}`)
    } catch {
      continue
    }
  }
  return null
}

/** Every stock address, for balance reads. */
export const STOCK_ADDRESSES = STOCKS.map((s) => s.address as Address)

/**
 * Live price of the chain's native asset, so a token not paired against a stock can still be shown
 * in dollars.
 *
 * ⚠ Replaces the old `fetchBnbUsd`, which asked Binance for BNBUSDT. The native asset here is ETH
 * and the price comes from Blockscout's own stats endpoint — the same source as the stock rates, so
 * every dollar figure on the site traces to one provider rather than two that can disagree.
 */
export async function fetchNativeUsd(): Promise<number | null> {
  try {
    const res = await fetch(`${BLOCKSCOUT}/api/v2/stats`)
    if (!res.ok) return null
    const body = (await res.json()) as { coin_price?: string | null }
    const n = Number(body.coin_price)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export { TOKEN_LAUNCHED_TOPIC0 }
