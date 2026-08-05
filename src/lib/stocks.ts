/**
 * The bStock catalogue.
 *
 * Replaces the old `mock.ts`. Nothing here is invented:
 *  - The ticker / company / sector rows are facts about which equities Binance has tokenised.
 *  - Every price and 24h change is fetched live from Binance, never hard-coded.
 *
 * The list is exactly the quote assets flap.sh offers, confirmed against flap's own UI on
 * 4 Aug 2026 — not every bStock that exists. A token can only be paired against one of these, so
 * listing others would offer creators a choice that does not exist.
 *
 * Verified the same day: all 10 resolve on chain (`symbol()` matches, `name()` is the real issuer)
 * and all 10 return live quotes from `api.binance.com/api/v3/ticker/24hr`.
 *
 * ⚠ Two are not equities. **XAUT is Tether Gold** — no `B` suffix and **6 decimals**, not 18 —
 * and SPYB/QQQB are index funds. Anything that assumes "stock" or 18 decimals here is wrong.
 */

export type Stock = {
  /** bStock ticker, e.g. NVDAB. */
  ticker: string
  /** The underlying listing, e.g. NVDA. */
  underlying: string
  company: string
  sector: string
  /**
   * The BEP-20 contract on BNB Chain.
   *
   * Each one was resolved from live DEX liquidity and then verified on chain: the contract's own
   * `symbol()` had to equal the ticker, and its `name()` had to be the real company ("NVIDIA Corp",
   * "Tesla, Inc.", "SpaceX"). Undefined where no BNB Chain market exists, so the UI links only to
   * tokens that were confirmed rather than to a guessed address.
   */
  address?: string
  /**
   * Token decimals, read from each contract on 4 Aug 2026 rather than assumed.
   * ⚠ XAUT is 6, every other one is 18. Static contract metadata, so it cannot drift.
   */
  decimals: number
}

/** Live quote for one bStock. */
export type Quote = {
  priceUsd: number
  change24h: number
  /** 24h quote volume in USDT — a real liquidity signal, unlike an invented "pool count". */
  volumeUsd: number
}

export const STOCKS: Stock[] = [
  { ticker: 'SPCXB', underlying: 'SPCX', company: 'SpaceX', sector: 'Aerospace', address: '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1' , decimals: 18 },
  { ticker: 'SKHYB', underlying: 'SKHY', company: 'SK Hynix', sector: 'Semiconductors', address: '0xCA750eF65f295BBECd685Abf54e82CAf297BDB61' , decimals: 18 },
  { ticker: 'SPYB', underlying: 'SPY', company: 'SPDR S&P 500 ETF', sector: 'Index fund', address: '0x7138b48df7D98D7e3cc221BfE7192D0a178182D8' , decimals: 18 },
  { ticker: 'XAUT', underlying: 'XAU', company: 'Tether Gold', sector: 'Commodity', address: '0x21cAef8A43163Eea865baeE23b9C2E327696A3bf' , decimals: 6 },
  { ticker: 'QQQB', underlying: 'QQQ', company: 'Invesco QQQ ETF', sector: 'Index fund', address: '0x205812CdBed920aFf76C6580abD681a46D11efc7' , decimals: 18 },
  { ticker: 'NVDAB', underlying: 'NVDA', company: 'NVIDIA', sector: 'Semiconductors', address: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436' , decimals: 18 },
  { ticker: 'AAPLB', underlying: 'AAPL', company: 'Apple', sector: 'Consumer Tech', address: '0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A' , decimals: 18 },
  { ticker: 'TSLAB', underlying: 'TSLA', company: 'Tesla', sector: 'Automotive', address: '0x5b1910eAaD6450E50f816082Aa078C41F10C292f' , decimals: 18 },
  { ticker: 'MSFTB', underlying: 'MSFT', company: 'Microsoft', sector: 'Software', address: '0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0' , decimals: 18 },
  { ticker: 'HOODB', underlying: 'HOOD', company: 'Robinhood', sector: 'Fintech', address: '0xA394dCEa3fd3847fD793afBFd163E2e3858B7c65' , decimals: 18 },
]

export function stockByTicker(ticker: string): Stock | undefined {
  return STOCKS.find((s) => s.ticker === ticker)
}

/**
 * Live quotes for every bStock, keyed by ticker.
 *
 * One request for all symbols. A symbol Binance does not know is simply absent from the result
 * rather than defaulted to zero — the UI renders "—" for it, because a fabricated price is worse
 * than a missing one.
 */
export async function fetchQuotes(): Promise<Record<string, Quote>> {
  const symbols = STOCKS.map((s) => `"${s.ticker}USDT"`).join(',')
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(`[${symbols}]`)}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance returned ${res.status}`)

  const rows = (await res.json()) as Array<{
    symbol: string
    lastPrice: string
    priceChangePercent: string
    quoteVolume: string
  }>
  if (!Array.isArray(rows)) throw new Error('Unexpected response from Binance')

  const out: Record<string, Quote> = {}
  for (const r of rows) {
    const ticker = r.symbol.replace(/USDT$/, '')
    const priceUsd = Number(r.lastPrice)
    if (!Number.isFinite(priceUsd)) continue
    out[ticker] = {
      priceUsd,
      change24h: Number(r.priceChangePercent),
      volumeUsd: Number(r.quoteVolume),
    }
  }
  return out
}
