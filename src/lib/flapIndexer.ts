/**
 * Reads real flap.sh launches and token state off BNB Chain.
 *
 * Unlike the launch *calldata* (see `flap.ts` — still undecodable), the launch **event** is fully
 * understood, and so is pool derivation. Everything in this file is live chain data.
 */

import { erc20Abi, getAddress, hexToBigInt, parseAbi, type Address, type Hex } from 'viem'
import { publicClient } from './chain'
import { STOCKS } from './stocks'
import { FLAP } from './flap'

/**
 * The launch event, emitted by the Portal once per launch.
 *
 * ⚠ **topic0 alone is not enough.** Measured against mainnet on 4 Aug 2026: over a 400-block
 * window, 2,399 Portal logs carried this topic0 but only **69 were launches**. The rest are other
 * events sharing it — payloads of 32/64/96/128/224 bytes, many with 2 or 3 topics. Decoding those
 * as launches yields garbage addresses.
 *
 * The shape filter that works: **exactly one topic, and at least 448 bytes of data.** Applying it
 * gave 69 launches whose sequential indices were contiguous (1704609…1704678) and whose token
 * addresses all ended in `7777` — flap's vanity grind — which is independent confirmation that
 * nothing was missed and nothing extra crept in.
 *
 * Not exactly 448: a longer name or symbol pushes the payload out. A 480-byte log in the same
 * window decoded cleanly to "Y'all Street" / YALL and filled the one gap in the index run.
 *
 * ⚠ Do NOT filter on the `7777` suffix. It held for all 69 tokens in the 400-block sample but not
 * across a 1,000-block one — flap does not always land the vanity grind. The contiguous index run
 * is the reliable correctness check (1,000 blocks: 5,093 raw logs → 164 launches, span 164, zero
 * missing).
 */
export const LAUNCH_TOPIC0 =
  '0x504e7f360b2e5fe33cbaaae4c593bc55305328341bf79009e43e0e3b7f699603' as const

/** Minimum data length of a launch payload, in bytes. */
export const LAUNCH_MIN_BYTES = 448

/**
 * flap's own V2-style pair factory.
 *
 * ⛔ The PancakeSwap V3 factory returns `address(0)` for these tokens — that route is a dead end.
 * This one returns a live pair for tokens minutes old.
 */
export const FLAP_V2_FACTORY = '0x4db4fcfebbf3f0cbd20efff444b133b96abda2d6' as const

/**
 * PancakeSwap V2. Needed as well as flap's own factory, not instead of it.
 *
 * Measured on a live bStock-paired token (JACKET/NVDAB): flap's factory returned `address(0)` for
 * every quote asset, while PancakeSwap V2 held the real pair. A token that has graduated off the
 * curve moves here, so checking only flap's factory shows "no pair" for exactly the established
 * tokens most worth listing.
 */
export const PANCAKE_V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73' as const

const FACTORY_ABI = parseAbi(['function getPair(address,address) view returns (address)'])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])

const ZERO = '0x0000000000000000000000000000000000000000'

export type LaunchEvent = {
  timestamp: number
  deployer: Address
  index: bigint
  token: Address
  name: string
  symbol: string
  cid: string
  blockNumber: bigint
  txHash: Hex
}

/** Reads a 32-byte word out of the event data, 0-indexed. */
function word(data: Hex, i: number): Hex {
  return `0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`
}

function wordAddress(data: Hex, i: number): Address {
  return getAddress(`0x${data.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`)
}

/** Reads an ABI-encoded string whose length word sits at `byteOffset` into the data. */
function stringAt(data: Hex, byteOffset: number): string {
  const start = 2 + byteOffset * 2
  if (start + 64 > data.length) return ''
  const lenHex = data.slice(start, start + 64)
  // A truncated or non-hex length word means this is not the layout we think it is.
  if (!/^[0-9a-fA-F]{64}$/.test(lenHex)) return ''
  const len = Number(hexToBigInt(`0x${lenHex}` as Hex))
  if (!len || len > 512) return ''
  const hex = data.slice(start + 64, start + 64 + len * 2)
  if (hex.length < len * 2) return ''

  // Decode as UTF-8, not latin-1. Plenty of live flap tokens have CJK or emoji names, and reading
  // each byte as a code point turns them into mojibake ("火星矿工" → "ç«æç¿å·¥").
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

/**
 * Decodes one launch log.
 *
 * Layout (448 bytes, no indexed args):
 *   w0 timestamp · w1 deployer · w2 sequential index · w3 new token
 *   w4-6 string offsets → name, symbol, IPFS CID
 */
export function decodeLaunchLog(log: {
  data: Hex
  topics: readonly string[]
  blockNumber: bigint
  transactionHash: Hex
}): LaunchEvent | null {
  // Shape gate — see LAUNCH_TOPIC0. Without this, ~97% of topic0 matches decode to garbage.
  if (log.topics.length !== 1) return null
  const d = log.data
  if ((d.length - 2) / 2 < LAUNCH_MIN_BYTES) return null

  try {
    const token = wordAddress(d, 3)
    const symbol = stringAt(d, Number(hexToBigInt(word(d, 5))))
    // A launch always names a real token and carries a symbol. Anything else is a different event
    // that happens to be long enough.
    if (!symbol || token === ZERO) return null

    return {
      timestamp: Number(hexToBigInt(word(d, 0))),
      deployer: wordAddress(d, 1),
      index: hexToBigInt(word(d, 2)),
      token,
      name: stringAt(d, Number(hexToBigInt(word(d, 4)))),
      symbol,
      cid: stringAt(d, Number(hexToBigInt(word(d, 6)))),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
    }
  } catch {
    return null
  }
}

/**
 * Scans recent blocks for launches.
 *
 * `deployers` filters to tokens launched by specific wallets — that is how "launched from bStake"
 * is determined, since the launcher wallet is the deployer. Omit it to see every flap launch.
 *
 * ⚠ Cost: the Portal emits ~5 logs per block carrying this topic0 (5,093 per 1,000 blocks
 * measured), and the deployer filter can only be applied *after* they are fetched. So the window
 * is deliberately small — 2,000 blocks is roughly 10k logs over the wire, which a browser can take
 * but is already the point where a server-side indexer becomes the right answer.
 */
export async function scanLaunches(opts: {
  blocks?: number
  deployers?: readonly string[]
  chunk?: number
} = {}): Promise<LaunchEvent[]> {
  const { blocks = 2_000, deployers, chunk = 500 } = opts
  const head = await publicClient.getBlockNumber()
  const from = head > BigInt(blocks) ? head - BigInt(blocks) : 0n

  const wanted = deployers?.length
    ? new Set(deployers.map((d) => d.toLowerCase()))
    : null

  const out: LaunchEvent[] = []
  // Chunked because public endpoints cap the getLogs range; failures on one chunk must not lose
  // the others, so each is caught independently.
  for (let start = from; start <= head; start += BigInt(chunk)) {
    const end = start + BigInt(chunk) - 1n > head ? head : start + BigInt(chunk) - 1n
    try {
      const logs = await publicClient.getLogs({
        address: FLAP.portal as Address,
        fromBlock: start,
        toBlock: end,
        // viem needs the raw topic here — the event has no ABI we can trust.
        // @ts-expect-error raw topic filter, no typed event available
        topics: [LAUNCH_TOPIC0],
      })
      for (const log of logs) {
        const ev = decodeLaunchLog(log)
        if (!ev) continue
        if (wanted && !wanted.has(ev.deployer.toLowerCase())) continue
        out.push(ev)
      }
    } catch {
      // Endpoint refused this range; skip it rather than aborting the whole scan.
    }
  }
  return out.sort((a, b) => Number(b.blockNumber - a.blockNumber))
}

/**
 * Pulls the new token address out of a confirmed launch receipt.
 *
 * Reuses `decodeLaunchLog`, so the shape rules (one topic, ≥448 bytes) live in exactly one place.
 * Lives here rather than in `flap.ts` to avoid an import cycle between the two modules.
 */
export function tokenFromReceipt(receipt: {
  logs: readonly { address: string; data: string; topics: readonly string[] }[]
}): Address | null {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== FLAP.portal.toLowerCase()) continue
    if (log.topics[0]?.toLowerCase() !== LAUNCH_TOPIC0) continue
    const ev = decodeLaunchLog({
      data: log.data as Hex,
      topics: log.topics,
      blockNumber: 0n,
      transactionHash: '0x' as Hex,
    })
    if (ev) return ev.token
  }
  return null
}

export type PairInfo = {
  pair: Address
  /** bStock ticker the pair is quoted in, or null when the quote asset is BNB. */
  quoteTicker: string | null
}

export type OnChainToken = {
  address: Address
  name: string
  symbol: string
  decimals: number
  totalSupply: bigint
  /** flap V2 pair, against whichever quote asset it was launched with. Null if none exists yet. */
  pair: Address | null
  /** bStock ticker the pair is quoted in, or null for a BNB-quoted pair. */
  quoteTicker: string | null
  /** Price in units of the quote asset per token, from pair reserves. */
  priceQuote: number | null
  /** The quote side of the pair, in its own units. A rough liquidity read. */
  liquidityQuote: number | null
}

/** Reads ERC-20 metadata. Batched into a single multicall by the client. */
export async function readTokenMeta(address: Address) {
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'name' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: 'totalSupply' }),
  ])
  return { name, symbol, decimals, totalSupply }
}

/**
 * Finds the flap V2 pair for a token.
 *
 * ⚠ Checking only the WBNB pair is wrong here. A token launched through bStake is paired against a
 * **bStock**, not BNB — that is the entire point of the product — so a WBNB-only lookup returns
 * nothing for exactly the tokens this site exists to list. Every known quote asset is tried, and
 * the one that hit is reported so the price can be denominated correctly.
 */
export async function findPair(token: Address): Promise<PairInfo | null> {
  const quotes: { address: Address; ticker: string | null }[] = [
    { address: FLAP.wbnb as Address, ticker: null }, // null = quoted in BNB
    ...STOCKS.filter((s) => s.address).map((s) => ({ address: s.address as Address, ticker: s.ticker })),
  ]
  const factories = [FLAP_V2_FACTORY, PANCAKE_V2_FACTORY] as const

  const combos = factories.flatMap((factory) => quotes.map((q) => ({ factory, ...q })))

  // One batch: viem folds these into multicalls rather than dozens of sequential round trips.
  const found = await Promise.all(
    combos.map((c) =>
      publicClient
        .readContract({
          address: c.factory,
          abi: FACTORY_ABI,
          functionName: 'getPair',
          args: [token, c.address],
        })
        .catch(() => ZERO as string),
    ),
  )

  const existing: { pair: Address; ticker: string | null }[] = []
  for (let i = 0; i < combos.length; i++) {
    const pair = found[i] as string
    if (pair && pair.toLowerCase() !== ZERO) existing.push({ pair: pair as Address, ticker: combos[i].ticker })
  }
  if (existing.length === 0) return null
  if (existing.length === 1) return { pair: existing[0].pair, quoteTicker: existing[0].ticker }

  // ⚠⚠ Existing is not the same as live. A token that graduates off the flap curve moves to
  // PancakeSwap V2 and its flap pair is left with ZERO reserves — so returning the first pair that
  // exists reports the successful tokens as dead, with a null price and no liquidity. Proven on
  // CLIPPY: flap pair 0/0, Pancake pair holding 186M CLIPPY against 23.87 MSFTB.
  //
  // So every pair that exists is measured and the deepest one wins.
  const depths = await Promise.all(
    existing.map((e) =>
      publicClient
        .readContract({ address: e.pair, abi: PAIR_ABI, functionName: 'getReserves' })
        .then((r) => {
          const [r0, r1] = r as unknown as [bigint, bigint, number]
          // Which side is the token does not matter for ranking: an empty pair is empty on both.
          return r0 < r1 ? r0 : r1
        })
        .catch(() => 0n),
    ),
  )

  let best = 0
  for (let i = 1; i < existing.length; i++) if (depths[i] > depths[best]) best = i

  // Every candidate is empty — a launched-but-untraded token. Keep the first so the pair address
  // is still reported, and let the reserve read produce the dashes.
  return { pair: existing[best].pair, quoteTicker: existing[best].ticker }
}

export async function readPair(pair: Address, token: Address, decimals: number) {
  const [reserves, token0, token1] = await Promise.all([
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' }),
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' }),
    publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token1' }),
  ])

  const [r0, r1] = reserves as unknown as [bigint, bigint, number]
  const tokenIsZero = (token0 as string).toLowerCase() === token.toLowerCase()
  const tokenReserve = tokenIsZero ? r0 : r1
  const quoteReserve = tokenIsZero ? r1 : r0
  const quoteToken = (tokenIsZero ? token1 : token0) as Address

  // Read the quote's decimals rather than assuming 18 — CRCLB is 8, and assuming would misprice
  // it by ten orders of magnitude.
  const quoteDecimals = await publicClient
    .readContract({ address: quoteToken, abi: erc20Abi, functionName: 'decimals' })
    .catch(() => 18)

  const tokenFloat = Number(tokenReserve) / 10 ** decimals
  const quoteFloat = Number(quoteReserve) / 10 ** Number(quoteDecimals)
  return {
    priceQuote: tokenFloat > 0 ? quoteFloat / tokenFloat : null,
    liquidityQuote: quoteFloat,
  }
}

/** Full on-chain read for one token: metadata plus pool state. */
export async function readToken(address: Address): Promise<OnChainToken> {
  const meta = await readTokenMeta(address)
  const found = await findPair(address)
  let priceQuote: number | null = null
  let liquidityQuote: number | null = null
  if (found) {
    const p = await readPair(found.pair, address, meta.decimals)
    priceQuote = p.priceQuote
    liquidityQuote = p.liquidityQuote
  }
  return {
    address,
    ...meta,
    pair: found?.pair ?? null,
    quoteTicker: found?.quoteTicker ?? null,
    priceQuote,
    liquidityQuote,
  }
}

/**
 * Reads an owner's balance of several tokens at once.
 *
 * Returned as raw base units keyed by lowercased address; a token that fails to read is simply
 * absent rather than reported as zero, so "could not read" is never mistaken for "you hold none".
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

/** Live BNB/USD, so on-chain prices can be shown in dollars. */
export async function fetchBnbUsd(): Promise<number | null> {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT')
    if (!res.ok) return null
    const json = (await res.json()) as { price?: string }
    const n = Number(json.price)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
