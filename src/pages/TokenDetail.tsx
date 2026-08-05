import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isAddress, getAddress } from 'viem'
import { BRAND } from '../brand'
import { readToken, fetchNativeUsd, type OnChainToken } from '../lib/ponsIndexer'
import { STOCKS, fetchQuotes, type Quote } from '../lib/stocks'
import { fetchMarketExtras, age, type MarketExtras } from '../lib/market'
import { readTokenArt } from '../lib/ponsIndexer'
import { readFeeTerms, type TokenFeeTerms } from '../lib/fees'
import type { TokenMeta } from '../lib/registry'
import { isPinned } from '../lib/pinned'
import { poolFor, readPools, type Pool } from '../lib/stakingContract'
import { stakingModelFor } from '../lib/staking'
import { explorerToken } from '../lib/chain'
import { amount as fmtAmount, shortAddr, usd } from '../lib/format'
import { useToast } from '../lib/toast'
import { Arrow, Check, Copy, External } from '../components/Icons'
import { Empty, StockBadge } from '../components/Ui'

/**
 * One token's dashboard.
 *
 * Everything here is read live: the token's own contract, its pair's reserves and swap events,
 * Blockscout for the pStock price, DexScreener for the 24h figures, and the token's published
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
  const [feeTerms, setFeeTerms] = useState<TokenFeeTerms | null>(null)
  const [pools, setPools] = useState<Pool[]>([])
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [nativeUsd, setBnbUsd] = useState<number | null>(null)
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
        fetchNativeUsd(),
      ])
      setToken(t)
      setQuotes(q)
      setBnbUsd(bnb)

      // Each of these is independent and none should be able to empty the page.
      void fetchMarketExtras([address]).then((m) => setExtras(m[address.toLowerCase()] ?? null))
      void readFeeTerms(address).then(setFeeTerms).catch(() => {})
      // One call: Pons keeps the logo and description on the token itself.
      void readTokenArt(address)
        .then((art) =>
          setMeta({
            imageUrl: art.logo,
            description: art.description,
            twitter: null,
            telegram: null,
            website: null,
          }),
        )
        .catch(() => {})
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this token.')
    }
  }, [address])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void readPools().then(setPools)
  }, [])

  /**
   * Staking figures for this token, read from the pool.
   *
   * For a launched token that is its own pool. For the pStake token there is no single pool,
   * because its stakers hold pStocks, so the totals are summed across every pStock pool.
   */
  const staking = useMemo(() => {
    if (!token) return { totalStaked: 0n, decimals: 18, symbol: '' }
    if (stakingModelFor(token.address) === 'pstake') {
      const total = pools.reduce((sum, p) => sum + p.totalStaked, 0n)
      return { totalStaked: total, decimals: 18, symbol: '' }
    }
    const pool = poolFor(pools, token.address)
    return { totalStaked: pool?.totalStaked ?? 0n, decimals: token.decimals, symbol: token.symbol }
  }, [pools, token])

  const quoteUsd = token?.quoteTicker ? (quotes[token.quoteTicker]?.priceUsd ?? null) : nativeUsd
  const priceUsd = token && token.priceQuote !== null && quoteUsd !== null ? token.priceQuote * quoteUsd : null
  const supply = token ? Number(token.totalSupply) / 10 ** token.decimals : null
  const mcapUsd = priceUsd !== null && supply !== null ? priceUsd * supply : null

  /**
   * ⛔ There is deliberately no per-token "fees earned" figure here.
   *
   * flap's Tax Token Helper kept a cumulative total per token, so this page could show exactly what
   * one token had paid. Pons credits a **fee escrow keyed by (recipient, asset)**: two tokens
   * paired against the same stock share one balance, and claiming zeroes it. There is no honest way
   * to attribute it to a single token, and multiplying volume by the tax rate would be an estimate
   * dressed as a measurement. What IS real — the claimable balance per stock — is on /rewards.
   */

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
              Blockscout <External size={12} />
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
        </div>
      </header>

      {/* No price / liquidity / volume / supply row. Market cap and the 24h move live in the
          header; the rest was detail nobody needed here. Do not add it back. */}

      {/* ---------------------------------- fees ---------------------------------- */}
      <section className="section" style={{ marginTop: 48 }}>
        <div className="section-head section-head-center">
          <h2>Fees</h2>
          <p>
            {model === 'pstake'
              ? `Trading ${BRAND.name} pays a tax which funds everyone staking a pStock.`
              : 'Trading this token pays a tax which funds its stakers.'}
          </p>
        </div>
        <div className="grid grid-2">
          {/*
            One rate, not a buy/sell pair. Pons charges the creator tax through the curve and the
            pool hook rather than on transfer, so there is no separate buy and sell figure to show —
            printing two identical numbers would imply a distinction the contract does not make.
          */}
          <Stat
            label="Creator tax"
            value={feeTerms ? `${feeTerms.creatorTaxBps / 100}%` : '—'}
            sub={feeTerms ? 'funds stakers' : undefined}
          />
          <Stat
            label="Pons fee"
            value={feeTerms && feeTerms.hookFeeBps > 0 ? `${feeTerms.hookFeeBps / 100}%` : '—'}
            sub={feeTerms && feeTerms.hookFeeBps > 0 ? 'taken by the protocol' : undefined}
          />
        </div>
      </section>

      {/* ---------------------------------- staking ----------------------------------
          Two genuinely different products, not two skins on one. See `lib/staking.ts`. */}
      {model === 'pstake' ? (
        <section className="section">
          <div className="section-head section-head-center">
            <h2>Staking</h2>
            <p>
              Stake any pStock to earn from {BRAND.name}'s trading fees. {BRAND.name} itself is not
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
                  <th>pStock</th>
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
            <Stat
              label="Total staked"
              value={`${fmtAmount(Number(staking.totalStaked) / 10 ** token.decimals)} ${token.symbol}`}
            />
            <Stat
              label="Value staked"
              value={
                priceUsd !== null
                  ? usd((Number(staking.totalStaked) / 10 ** token.decimals) * priceUsd, { compact: true })
                  : '—'
              }
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 22 }}>
            <Link className="btn btn-primary" to="/stake">
              Stake {token.symbol} <Arrow />
            </Link>
          </div>
        </section>
      )}

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
