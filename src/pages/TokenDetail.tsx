import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isAddress, getAddress } from 'viem'
import { BRAND } from '../brand'
import { readToken, fetchBnbUsd, type OnChainToken } from '../lib/flapIndexer'
import { STOCKS, fetchQuotes, stockByTicker, type Quote } from '../lib/stocks'
import { fetchMarketExtras, age, type MarketExtras } from '../lib/market'
import { fetchTokenMeta, type TokenMeta } from '../lib/tokenMeta'
import { readRecentTrades, priceSeries, type Trade } from '../lib/trades'
import { readTokenTaxes, readTaxTokenInfo, type TokenTaxes, type TaxTokenInfo } from '../lib/tax'
import { isPinned } from '../lib/pinned'
import { stakingModelFor } from '../lib/staking'
import { explorerToken, explorerTx } from '../lib/chain'
import { amount as fmtAmount, shortAddr, usd } from '../lib/format'
import { useToast } from '../lib/toast'
import { Arrow, Check, Copy, External } from '../components/Icons'
import { Empty, Sparkline, StockBadge } from '../components/Ui'

/**
 * One token's dashboard.
 *
 * Everything here is read live: the token's own contract, its pair's reserves and swap events,
 * Binance for the bStock price, DexScreener for the 24h figures, and the token's published
 * metadata for artwork and links. Nothing is invented — a value that cannot be read renders a dash.
 *
 * Staking figures read from the pool and are zero until somebody stakes.
 */
export default function TokenDetail() {
  const { address: raw } = useParams()
  const toast = useToast()

  const [token, setToken] = useState<OnChainToken | null>(null)
  const [extras, setExtras] = useState<MarketExtras | null>(null)
  const [meta, setMeta] = useState<TokenMeta | null>(null)
  const [taxes, setTaxes] = useState<TokenTaxes | null>(null)
  const [taxInfo, setTaxInfo] = useState<TaxTokenInfo | null>(null)
  const [trades, setTrades] = useState<Trade[] | null>(null)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [bnbUsd, setBnbUsd] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [broken, setBroken] = useState(false)

  // ⚠ Lowercased before validating. `isAddress` enforces the EIP-55 checksum, so a valid address
  // pasted from a block explorer or a chat message in the wrong case would render "Token not
  // found" — a real address, rejected on presentation. Casing is normalised, then re-checksummed.
  const normalised = raw?.trim().toLowerCase()
  const valid = !!normalised && isAddress(normalised)
  const address = valid ? getAddress(normalised) : null

  const load = useCallback(async () => {
    if (!address) return
    setError(null)
    try {
      const [t, q, bnb] = await Promise.all([
        readToken(address),
        fetchQuotes().catch((): Record<string, Quote> => ({})),
        fetchBnbUsd(),
      ])
      setToken(t)
      setQuotes(q)
      setBnbUsd(bnb)

      // Each of these is independent and none should be able to empty the page.
      void fetchMarketExtras([address]).then((m) => setExtras(m[address.toLowerCase()] ?? null))
      void readTokenTaxes(address).then(setTaxes).catch(() => {})
      void readTaxTokenInfo(address).then(setTaxInfo).catch(() => {})
      void fetchMarketExtras([address])
        .then((m) => fetchTokenMeta(address, m[address.toLowerCase()]?.createdAtMs ?? null))
        .then(setMeta)
        .catch(() => {})

      if (t.pair) {
        const stock = t.quoteTicker ? stockByTicker(t.quoteTicker) : undefined
        void readRecentTrades({
          pair: t.pair,
          token: address,
          tokenDecimals: t.decimals,
          quoteDecimals: stock?.decimals ?? 18,
        })
          .then(setTrades)
          .catch(() => setTrades([]))
      } else {
        setTrades([])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this token.')
    }
  }, [address])

  useEffect(() => {
    void load()
  }, [load])

  const quoteUsd = token?.quoteTicker ? (quotes[token.quoteTicker]?.priceUsd ?? null) : bnbUsd
  const priceUsd = token && token.priceQuote !== null && quoteUsd !== null ? token.priceQuote * quoteUsd : null
  const supply = token ? Number(token.totalSupply) / 10 ** token.decimals : null
  const mcapUsd = priceUsd !== null && supply !== null ? priceUsd * supply : null

  /**
   * Fees this token has actually paid its beneficiary, cumulative.
   *
   * ⚠ Measured, not estimated. flap's Tax Token Helper keeps the running total per token, so this
   * is read rather than derived from volume × tax rate — an estimate that would drift away from
   * the truth the moment any tax was routed anywhere other than the beneficiary.
   *
   * The total is denominated in the QUOTE asset, so it is converted with that asset's own price
   * and decimals. XAUT is 6 decimals, not 18.
   */
  const feesEarned = useMemo(() => {
    if (!taxInfo || !token) return null
    const stock = token.quoteTicker ? stockByTicker(token.quoteTicker) : undefined
    const decimals = stock?.decimals ?? 18
    const inQuote = Number(taxInfo.totalQuoteSentToMarketing) / 10 ** decimals
    return { inQuote, usd: quoteUsd !== null ? inQuote * quoteUsd : null }
  }, [taxInfo, token, quoteUsd])

  const series = useMemo(() => (trades ? priceSeries(trades) : []), [trades])
  const image = broken ? null : (meta?.imageUrl ?? null)

  async function copy() {
    if (!address) return
    try {
      await navigator.clipboard.writeText(address)
    } catch {
      toast.show('Could not copy the address')
      return
    }
    setCopied(true)
    toast.show('Contract address copied')
    setTimeout(() => setCopied(false), 1400)
  }

  if (!valid) {
    return (
      <div className="wrap page">
        <Empty
          title="Token not found"
          body="That is not a valid contract address."
          action={
            <Link className="btn btn-primary" to="/tokens">
              Back to tokens <Arrow />
            </Link>
          }
        />
      </div>
    )
  }

  if (error) {
    return (
      <div className="wrap page">
        <Empty
          title="Could not read this token"
          body={error}
          action={
            <Link className="btn btn-primary" to="/tokens">
              Back to tokens <Arrow />
            </Link>
          }
        />
      </div>
    )
  }

  if (!token) {
    return (
      <div className="wrap page">
        <div className="card empty">
          <div className="spinner" />
          <h3 style={{ marginTop: 18 }}>Reading {BRAND.chain}…</h3>
        </div>
      </div>
    )
  }

  const pinned = isPinned(token.address)
  const model = stakingModelFor(token.address)
  const change = extras?.change24h ?? null

  return (
    <div className="wrap page">
      <Link to="/tokens" className="back-link">
        ← All tokens
      </Link>

      {/* ---------------------------------- header ---------------------------------- */}
      <header className={`td-head${pinned ? ' td-head-pinned' : ''}`}>
        <div className="td-art">
          {image ? (
            <img src={image} alt="" onError={() => setBroken(true)} />
          ) : (
            <span className="mono">{token.symbol.slice(0, 3).toUpperCase()}</span>
          )}
        </div>

        <div className="td-id">
          <div className="td-title">
            <h1>{pinned ? BRAND.pinned.name : token.name}</h1>
            {pinned && <span className="tcard-tag tcard-tag-hi">{BRAND.name}</span>}
          </div>
          <div className="td-sub">
            <span className="mono">{pinned ? BRAND.pinned.symbol : token.symbol}</span>
            {token.quoteTicker && (
              <>
                <span className="td-dot">·</span>
                <span>
                  paired with <StockBadge ticker={token.quoteTicker} to={false} />
                </span>
              </>
            )}
            {age(extras?.createdAtMs ?? null) && (
              <>
                <span className="td-dot">·</span>
                <span>{age(extras?.createdAtMs ?? null)}</span>
              </>
            )}
          </div>

          {meta?.description && <p className="td-desc">{meta.description}</p>}

          <div className="td-links">
            <button className="td-ca mono" onClick={() => void copy()} title={`Copy ${token.address}`}>
              {shortAddr(token.address)} {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <a href={explorerToken(token.address)} target="_blank" rel="noreferrer">
              BscScan <External size={12} />
            </a>
            {meta?.twitter && (
              <a href={meta.twitter} target="_blank" rel="noreferrer">
                X <External size={12} />
              </a>
            )}
            {meta?.telegram && (
              <a href={meta.telegram} target="_blank" rel="noreferrer">
                Telegram <External size={12} />
              </a>
            )}
            {meta?.website && (
              <a href={meta.website} target="_blank" rel="noreferrer">
                Website <External size={12} />
              </a>
            )}
          </div>
        </div>

        <div className="td-price">
          <span className="td-mcap">{mcapUsd !== null ? usd(mcapUsd, { compact: true }) : '—'}</span>
          <span className="td-mcap-label">Market cap</span>
          {change !== null && (
            <span className={`tcard-chg ${change >= 0 ? 'up' : 'down'}`}>
              {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}% 24h
            </span>
          )}
          {series.length > 0 && (
            <div className="td-spark">
              <Sparkline data={series} color={change !== null && change < 0 ? '#f6465d' : '#0ecb81'} fluid />
            </div>
          )}
        </div>
      </header>

      {/* No price / liquidity / volume / supply row. Market cap and the 24h move live in the
          header; the rest was detail nobody needed here. Do not add it back. */}

      {/* ---------------------------------- fees ---------------------------------- */}
      <section className="section" style={{ marginTop: 48 }}>
        <div className="section-head section-head-center">
          <h2>Fees</h2>
          <p>
            {model === 'bstake'
              ? `Trading ${BRAND.name} pays a tax which funds everyone staking a bStock.`
              : 'Trading this token pays a tax which funds its stakers.'}
          </p>
        </div>
        <div className="grid grid-3">
          <Stat label="Buy tax" value={taxes ? `${taxes.buyTaxBps / 100}%` : '—'} />
          <Stat label="Sell tax" value={taxes ? `${taxes.sellTaxBps / 100}%` : '—'} />
          <Stat
            label="Fees earned"
            value={feesEarned ? (feesEarned.usd !== null ? usd(feesEarned.usd) : '—') : '—'}
            sub={
              feesEarned && token.quoteTicker
                ? `${fmtAmount(feesEarned.inQuote)} ${token.quoteTicker} all time`
                : undefined
            }
          />
        </div>
      </section>

      {/* ---------------------------------- staking ----------------------------------
          Two genuinely different products, not two skins on one. See `lib/staking.ts`. */}
      {model === 'bstake' ? (
        <section className="section">
          <div className="section-head section-head-center">
            <h2>Staking</h2>
            <p>
              Stake any bStock to earn from {BRAND.name}'s trading fees. {BRAND.name} itself is not
              staked.
            </p>
          </div>

          <div className="grid grid-3">
            <Stat label="Total staked" value={usd(0)} />
            <Stat label="Stakers" value="0" />
            <Stat label="Rewards distributed" value={usd(0)} />
          </div>

          <div className="table-wrap" style={{ marginTop: 22 }}>
            <table>
              <thead>
                <tr>
                  <th>bStock</th>
                  <th className="right">Price</th>
                  <th className="right">Total staked</th>
                  <th className="right">Stakers</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {STOCKS.filter((s) => s.address).map((s) => (
                  <tr key={s.ticker}>
                    <td>
                      <div className="tk">
                        <StockBadge ticker={s.ticker} to={false} />
                        <span className="tk-sub">{s.company}</span>
                      </div>
                    </td>
                    <td className="right mono">
                      {quotes[s.ticker]?.priceUsd != null ? usd(quotes[s.ticker].priceUsd) : '—'}
                    </td>
                    <td className="right mono">0</td>
                    <td className="right mono">0</td>
                    <td className="right">
                      <Link className="btn btn-ghost" to="/stake">
                        Stake
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="section">
          <div className="section-head section-head-center">
            <h2>Staking</h2>
            <p>
              Stake this token to earn its trading fees
              {token.quoteTicker ? ` paid out in ${token.quoteTicker}` : ''}.
            </p>
          </div>
          <div className="grid grid-3">
            <Stat label="Total staked" value={`0 ${token.symbol}`} />
            <Stat label="Stakers" value="0" />
            <Stat label="Rewards distributed" value={usd(0)} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 22 }}>
            <Link className="btn btn-primary" to="/stake">
              Stake {token.symbol} <Arrow />
            </Link>
          </div>
        </section>
      )}

      {/* ---------------------------------- trades ---------------------------------- */}
      <section className="section">
        <div className="section-head section-head-center">
          <h2>Recent trades</h2>
        </div>
        {trades === null ? (
          <div className="card empty">
            <div className="spinner" />
          </div>
        ) : trades.length === 0 ? (
          <Empty title="No trades yet" body="Trades appear here as they happen on chain." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="right">{token.symbol}</th>
                  <th className="right">{token.quoteTicker ?? 'BNB'}</th>
                  <th className="right">Trader</th>
                  <th className="right">Tx</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={`${t.txHash}-${i}`}>
                    <td>
                      <span className={`badge ${t.kind === 'buy' ? 'badge-up' : 'badge-muted'}`}>
                        {t.kind === 'buy' ? 'Buy' : 'Sell'}
                      </span>
                    </td>
                    <td className="right mono">{fmtAmount(t.amount)}</td>
                    <td className="right mono">{fmtAmount(t.quoteAmount)}</td>
                    <td className="right mono">{shortAddr(t.trader)}</td>
                    <td className="right">
                      <a className="btn btn-ghost" href={explorerTx(t.txHash)} target="_blank" rel="noreferrer">
                        <External size={13} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}
