/**
 * 24h change, volume and token age — the numbers a pool's current state cannot tell you.
 *
 * Everything else on this site is read straight from chain, and price, liquidity and market cap
 * stay that way. But "how much did this move in 24h" needs yesterday's price, and "how old is it"
 * needs the launch time — neither is in the pair's current state. Getting them from chain means an
 * archive scan per token per page load, which is not something a browser should do.
 *
 * DexScreener indexes flap.sh (`dexId: "flapsh"`), serves `Access-Control-Allow-Origin: *`, and
 * takes up to 30 addresses per request — so the whole page costs one HTTP call. Anything it does
 * not know renders as a dash.
 *
 * ⚠⚠ **Read only pairs where our token is the BASE token.** DexScreener reports `priceChange`
 * against the base side, so for a pair like CLIPPY/MSFTB — where flap made the bStock the base —
 * `priceChange.h24` describes *MSFTB*, and using it would silently print an unrelated number under
 * our token's name. It is not the inverse either, since both sides move independently in USD, so
 * there is nothing to salvage: no base-side pair means no 24h figure. This is the same failure that
 * inverted every buy and sell in the V4 swap decoder.
 */

import type { Address } from 'viem'

export type MarketExtras = {
  /** Percent, signed. Null when no pair quotes this token as the base asset. */
  change24h: number | null
  volume24hUsd: number | null
  /** Pair creation time in ms — the age badge, and the seed for the metadata lookup. */
  createdAtMs: number | null
}

type DexPair = {
  baseToken?: { address?: string }
  quoteToken?: { address?: string }
  priceChange?: { h24?: number }
  volume?: { h24?: number }
  pairCreatedAt?: number
  liquidity?: { usd?: number }
}

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens/'

/** DexScreener's documented cap per request. */
const BATCH = 30

/**
 * Looks up extras for many tokens at once.
 *
 * Resolves to an empty map on any failure — this is decoration over data that is already correct,
 * so it must never take the page down with it.
 */
export async function fetchMarketExtras(
  addresses: readonly Address[],
): Promise<Record<string, MarketExtras>> {
  const out: Record<string, MarketExtras> = {}
  if (!addresses.length) return out

  const batches: Address[][] = []
  for (let i = 0; i < addresses.length; i += BATCH) batches.push([...addresses.slice(i, i + BATCH)])

  // Depth of the pair each entry came from, so a later shallower pair cannot overwrite a deeper one.
  const depth: Record<string, number> = {}
  // ⚠⚠ Creation time is tracked SEPARATELY, as the EARLIEST across every pair — not the one from
  // the deepest pair. A token that graduates off the flap curve gets a NEW PancakeSwap pair, and
  // that pair's creation time is the graduation, not the launch. Taking it would make a graduated
  // token look hours old instead of days, and would point the artwork lookup at the wrong block
  // entirely, so it silently finds no launch event and the token renders with no image.
  const earliest: Record<string, number> = {}

  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await fetch(ENDPOINT + batch.join(','))
        if (!res.ok) return
        const body = (await res.json()) as { pairs?: DexPair[] | null }
        for (const pair of body.pairs ?? []) {
          const base = pair.baseToken?.address?.toLowerCase()
          const quote = pair.quoteToken?.address?.toLowerCase()
          const isBase = !!base && batch.some((a) => a.toLowerCase() === base)
          const isQuote = !!quote && batch.some((a) => a.toLowerCase() === quote)
          if (!isBase && !isQuote) continue

          // Which side we are on decides what is safe to read. `pairCreatedAt` describes the pair
          // itself, so it is true either way — and it is what makes the artwork lookup possible for
          // a token flap listed as the quote asset. The price figures are base-side only.
          const key = (isBase ? base : quote) as string
          if (typeof pair.pairCreatedAt === 'number') {
            earliest[key] = Math.min(earliest[key] ?? Infinity, pair.pairCreatedAt)
          }

          const next: MarketExtras = {
            change24h: isBase && typeof pair.priceChange?.h24 === 'number' ? pair.priceChange.h24 : null,
            volume24hUsd: isBase && typeof pair.volume?.h24 === 'number' ? pair.volume.h24 : null,
            createdAtMs: null,
          }

          // A token can have several pairs. Keep the deepest, since that is the price the market
          // actually follows — a shallow pair's 24h move is noise from a handful of dollars.
          const liq = pair.liquidity?.usd ?? 0
          if (out[key] === undefined || liq > depth[key]) {
            out[key] = next
            depth[key] = liq
          }
        }
      } catch {
        /* offline, rate-limited, or blocked — the page shows dashes */
      }
    }),
  )

  // Apply the earliest creation time over whatever the deepest pair happened to report.
  for (const [key, ms] of Object.entries(earliest)) {
    if (out[key]) out[key].createdAtMs = ms
    else out[key] = { change24h: null, volume24hUsd: null, createdAtMs: ms }
  }

  return out
}

/** "6d", "3h", "just now" — the age badge on a token card. */
export function age(createdAtMs: number | null): string | null {
  if (!createdAtMs) return null
  const secs = Math.floor((Date.now() - createdAtMs) / 1000)
  if (secs < 60) return 'just now'
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  const days = Math.floor(secs / 86400)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return months < 12 ? `${months}mo ago` : `${Math.floor(months / 12)}y ago`
}
