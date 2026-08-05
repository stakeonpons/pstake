/**
 * The stock catalogue.
 *
 * ⭐ **This list is not a selection — it is the complete set of assets a Pons token can be paired
 * against, read from the chain.** Every one of the 202 Robinhood tokenized stocks on Robinhood
 * Chain was checked against `approvedPairTokens()` on the Pons launch factory on 5 Aug 2026, and
 * exactly these seven came back `true`. Listing any other Robinhood token would offer a pairing
 * the factory rejects.
 *
 * ⚠ Re-derive it rather than editing by hand if Pons approves more: the check is one multicall of
 * `approvedPairTokens` over the Blockscout token list. An earlier version of this product shipped a
 * hand-written quote-asset list that was wrong, and nothing in the UI could reveal it.
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
  /** Read from each contract rather than assumed. All seven are 18, unlike pons's XAUT at 6. */
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
 * The seven approved pair tokens, ordered by holder count — the closest thing to "most
 * established" that is a fact rather than an opinion.
 */
export const STOCKS: Stock[] = [
  { ticker: 'NVDA',  underlying: 'NVDA',  company: 'NVIDIA',           sector: 'Semiconductors', address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', decimals: 18 },
  { ticker: 'AAPL',  underlying: 'AAPL',  company: 'Apple',            sector: 'Consumer Tech',  address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', decimals: 18 },
  { ticker: 'SPCX',  underlying: 'SPCX',  company: 'SpaceX',           sector: 'Aerospace',      address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa', decimals: 18 },
  { ticker: 'GOOGL', underlying: 'GOOGL', company: 'Alphabet Class A', sector: 'Internet',       address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3', decimals: 18 },
  { ticker: 'TSLA',  underlying: 'TSLA',  company: 'Tesla',            sector: 'Automotive',     address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d', decimals: 18 },
  { ticker: 'SPY',   underlying: 'SPY',   company: 'SPDR S&P 500 ETF', sector: 'Index fund',     address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', decimals: 18 },
  { ticker: 'GME',   underlying: 'GME',   company: 'GameStop',         sector: 'Retail',         address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E', decimals: 18 },
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

  // One request covers all seven. This is decoration over data that is already correct, so a
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
