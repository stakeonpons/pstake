/**
 * The stock catalogue.
 *
 * ⭐ **This list is not a selection — it is the set of assets a Pons token can be paired against,
 * every entry verified against `approvedPairTokens()` on the V2 factory.** Listing anything else
 * would offer a pairing the factory rejects.
 *
 * ⚠⚠ **Deriving it by scanning "Robinhood tokenized stocks" MISSES ENTRIES.** That is how USDG was
 * absent for a day: it is a stablecoin, so it was never in the candidate set the scan asked about,
 * even though the factory approves it and tokens had already launched against it. The authority is
 * the factory, and the candidate set has to include non-equities.
 *
 * ⚠ Six different contracts on this chain call themselves USDG. Only one is approved; the rest are
 * impostors. Never match a pair token by symbol — check the address against the factory.
 *
 * ➤ Cross-check against Pons's own selector at ponsfamily.com/launchpad/create. As of 5 Aug 2026 it
 * offers native ETH plus the eight below. ETH is deliberately not listed here: a token paired
 * against it pays its stakers in ETH rather than in any stock, which is not this product.
 *
 * Prices come from Blockscout, not Binance — see `fetchQuotes`.
 */

import { BLOCKSCOUT } from './chain'

export type Stock = {
  /** stock ticker, e.g. NVDA. On Robinhood Chain the token carries the real ticker, unsuffixed. */
  ticker: string
  /** The underlying listing. Identical to `ticker` here; kept so callers need no special casing. */
  underlying: string
  company: string
  sector: string
  /** The ERC-20 contract on Robinhood Chain. */
  address: string
  /**
   * Read from each contract rather than assumed.
   *
   * ⚠⚠ **They are NOT all 18.** The seven equities are, but USDG is **6**. Anything that formats or
   * compares an amount must use this field; assuming 18 would misprint a USDG balance by 1e12.
   */
  decimals: number
}

/** Live quote for one stock. */
export type Quote = {
  priceUsd: number
  /**
   * Percent, signed — or **null when nothing on chain prices this stock's move**.
   *
   * ⚠ Blockscout publishes a price and a volume but **no 24h change**, so this comes from
   * DexScreener's pool data and is genuinely absent for a stock with no pool. Null renders as a
   * dash. Do not substitute zero: "unchanged" and "unknown" are different claims.
   */
  change24h: number | null
  volumeUsd: number | null
  /** Robinhood's own logo for the asset, served from their CDN and surfaced by Blockscout. */
  iconUrl: string | null
}

/**
 * The approved pair tokens. The equities are ordered by holder count — the closest thing to "most
 * established" that is a fact rather than an opinion — and USDG sits last because it is not one.
 */
export const STOCKS: Stock[] = [
  { ticker: 'NVDA',  underlying: 'NVDA',  company: 'NVIDIA',           sector: 'Semiconductors', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 },
  { ticker: 'AAPL',  underlying: 'AAPL',  company: 'Apple',            sector: 'Consumer Tech',  address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18 },
  { ticker: 'SPCX',  underlying: 'SPCX',  company: 'SpaceX Class A',   sector: 'Aerospace',      address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18 },
  { ticker: 'GOOGL', underlying: 'GOOGL', company: 'Alphabet Class A', sector: 'Internet',       address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18 },
  { ticker: 'TSLA',  underlying: 'TSLA',  company: 'Tesla',            sector: 'Automotive',     address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18 },
  { ticker: 'SPY',   underlying: 'SPY',   company: 'SPDR S&P 500 ETF', sector: 'Index fund',     address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18 },
  { ticker: 'GME',   underlying: 'GME',   company: 'GameStop',         sector: 'Retail',         address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', decimals: 18 },
  // ⚠ Not an equity, and ⚠⚠ 6 decimals rather than 18. Approved by the factory and already used
  // as a pair token on V2, so a token can genuinely pay its stakers in it.
  { ticker: 'USDG',  underlying: 'USDG',  company: 'Global Dollar',    sector: 'Stablecoin',     address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
]

export function stockByTicker(ticker: string): Stock | undefined {
  return STOCKS.find((s) => s.ticker === ticker)
}

export function stockByAddress(address: string): Stock | undefined {
  const a = address.toLowerCase()
  return STOCKS.find((s) => s.address.toLowerCase() === a)
}

const DEXSCREENER = 'https://api.dexscreener.com/latest/dex/tokens/'

/**
 * Live quotes for every stock, keyed by ticker.
 *
 * ⚠⚠ **Binance is not the price source here and cannot be.** Robinhood's tokenized equities are
 * not Binance markets; the old site quoted `NVDABUSDT` only because pons's stocks happened to be
 * listed there. Asking Binance for "NVDA" returns a different asset's price, or nothing.
 *
 * Blockscout publishes the authoritative rate per token (`exchange_rate`), plus 24h volume and
 * Robinhood's own icon. It does not publish a 24h change, so that one field comes from DexScreener
 * where a pool exists and stays null where none does.
 *
 * A stock that fails to resolve is absent from the result rather than defaulted: the UI renders a
 * dash, which is honest, where a zero would read as a real price of nothing.
 */
export async function fetchQuotes(): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {}

  const rates = await Promise.all(
    STOCKS.map(async (s) => {
      try {
        const r = await fetch(`${BLOCKSCOUT}/api/v2/tokens/${s.address}`)
        if (!r.ok) return null
        const j = (await r.json()) as {
          exchange_rate?: string | null
          volume_24h?: string | null
          icon_url?: string | null
        }
        const priceUsd = Number(j.exchange_rate)
        if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null
        const volume = Number(j.volume_24h)
        return {
          ticker: s.ticker,
          priceUsd,
          volumeUsd: Number.isFinite(volume) ? volume : null,
          iconUrl: j.icon_url ?? null,
        }
      } catch {
        return null
      }
    }),
  )

  for (const r of rates) {
    if (r) out[r.ticker] = { priceUsd: r.priceUsd, change24h: null, volumeUsd: r.volumeUsd, iconUrl: r.iconUrl }
  }

  // One request covers the whole list. This is decoration over data that is already correct, so a
  // failure leaves every change null rather than taking the quotes down with it.
  try {
    const res = await fetch(DEXSCREENER + STOCKS.map((s) => s.address).join(','))
    if (res.ok) {
      const body = (await res.json()) as {
        pairs?: Array<{
          baseToken?: { address?: string }
          priceChange?: { h24?: number }
          liquidity?: { usd?: number }
        }>
      }
      const best: Record<string, { change: number; depth: number }> = {}
      for (const p of body.pairs ?? []) {
        // ⚠ Base side only. DexScreener reports priceChange against the base token, so a pair where
        // the stock is the QUOTE describes the other asset's move under our ticker.
        const s = p.baseToken?.address ? stockByAddress(p.baseToken.address) : undefined
        const change = p.priceChange?.h24
        if (!s || typeof change !== 'number') continue
        const depth = p.liquidity?.usd ?? 0
        if (!best[s.ticker] || depth > best[s.ticker].depth) best[s.ticker] = { change, depth }
      }
      for (const [ticker, v] of Object.entries(best)) {
        if (out[ticker]) out[ticker].change24h = v.change
      }
    }
  } catch {
    /* leave every change24h null */
  }

  return out
}
