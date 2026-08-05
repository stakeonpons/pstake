import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { BRAND } from '../brand'
import { STOCKS, fetchQuotes, type Quote } from '../lib/stocks'
import { explorerToken } from '../lib/chain'
import { compact, pct, usd } from '../lib/format'
import { External, Info, Search } from '../components/Icons'
import { Empty } from '../components/Ui'

export default function Stocks() {
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [quotes, setQuotes] = useState<Record<string, Quote> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const next = params.get('q')
    if (next) setQ(next)
  }, [params])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setQuotes(await fetchQuotes())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach Blockscout.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    // Prices move; refresh while the page is open rather than freezing on first paint.
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = STOCKS.filter(
      (s) =>
        !needle ||
        s.ticker.toLowerCase().includes(needle) ||
        s.underlying.toLowerCase().includes(needle) ||
        s.company.toLowerCase().includes(needle) ||
        s.sector.toLowerCase().includes(needle),
    )
    if (!quotes) return list
    // Busiest first — real 24h volume, rather than an invented popularity number.
    return [...list].sort((a, b) => (quotes[b.ticker]?.volumeUsd ?? -1) - (quotes[a.ticker]?.volumeUsd ?? -1))
  }, [q, quotes])

  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>pStocks</h1>
        <p>
          pStocks are ERC-20 tokens on {BRAND.chain}, each backed 1:1 by the real asset it tracks.
        </p>
        <p>These are the assets a token can be paired against on {BRAND.launchpad}.</p>
      </div>

      <div className="toolbar">
        <label className="search">
          <Search />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by ticker, company or sector"
          />
        </label>
        <button className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: 20 }}>
          <Info />
          <div>
            <b>Could not load live prices</b>
            <p>{error}</p>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <Empty title="No pStocks match" body="Try a ticker like NVDA, or a company name." />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>pStock</th>
                <th>Sector</th>
                <th className="right">Price</th>
                <th className="right">24h</th>
                <th className="right">24h volume</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const quote = quotes?.[s.ticker]
                return (
                  <tr key={s.ticker}>
                    <td>
                      {/* Links to the verified ERC-20 on Robinhood Chain. Stocks with no confirmed
                          contract render as plain text rather than a dead or guessed link. */}
                      {s.address ? (
                        <a
                          className="tk stock-link"
                          href={explorerToken(s.address)}
                          target="_blank"
                          rel="noreferrer"
                          title={`View ${s.ticker} on Blockscout`}
                        >
                          <span className="tk-glyph mono" style={{ fontSize: 13, fontWeight: 700 }}>
                            {s.underlying.slice(0, 2)}
                          </span>
                          <span>
                            <span className="tk-name mono">
                              {s.ticker}
                              <External size={12} />
                            </span>
                            <span className="tk-sub" style={{ display: 'block' }}>
                              {s.company}
                            </span>
                          </span>
                        </a>
                      ) : (
                        <div className="tk">
                          <span className="tk-glyph mono" style={{ fontSize: 13, fontWeight: 700 }}>
                            {s.underlying.slice(0, 2)}
                          </span>
                          <span>
                            <span className="tk-name mono">{s.ticker}</span>
                            <span className="tk-sub" style={{ display: 'block' }}>
                              {s.company}
                            </span>
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="muted">{s.sector}</td>
                    <td className="right mono">
                      {quote ? usd(quote.priceUsd) : <span className="muted">—</span>}
                    </td>
                    {/*
                      ⚠ The 24h move is genuinely absent for a stock with no on-chain pool:
                      Blockscout publishes a rate but no change, and DexScreener only knows assets
                      that trade. A dash says "not known"; a zero would claim it did not move.
                    */}
                    <td className="right">
                      {quote?.change24h != null ? (
                        <span className={`mono ${quote.change24h >= 0 ? 'up' : 'down'}`}>
                          {pct(quote.change24h)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="right mono">
                      {quote?.volumeUsd != null ? '$' + compact(quote.volumeUsd) : <span className="muted">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* One card split into two columns rather than two separate cards. As separate cards the
          short one left a lot of dead space, and centred prose is ragged on both edges and harder
          to read — left-aligned inside a single bordered unit fixes both. */}
      <section className="section">
        <div className="card info-split">
          <div>
            <h2>How it works</h2>
            <p>
              Each pStock is issued against the underlying asset, bought and held by a regulated
              custodian. Supply on chain tracks what is in custody one for one, so the token stays
              redeemable and its price tracks the real thing. For equities, dividends and corporate
              actions pass through to holders.
            </p>
            <p>
              Because it is a plain ERC-20, a pStock also works anywhere else on {BRAND.chain}. Swap
              it on Uniswap, or post it as collateral on lending markets, without unwinding your
              position.
            </p>
          </div>

          <div>
            <h2>Why fees settle in pStocks</h2>
            <p>
              On {BRAND.launchpad}, a token is launched against a quote asset. When that quote asset
              is a pStock, every trade against the pair generates fees denominated in that stock, so
              paying stakers in it is the natural settlement.
            </p>
          </div>
        </div>
      </section>

    </div>
  )
}
