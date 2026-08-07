import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { isAddress, getAddress, type Address } from 'viem'
import { BRAND } from '../brand'
import { readToken, fetchNativeUsd, type OnChainToken } from '../lib/ponsIndexer'
import { STOCKS, fetchQuotes, type Quote } from '../lib/stocks'
import { fetchMarketExtras, age, type MarketExtras } from '../lib/market'
import { readTokenArt } from '../lib/ponsIndexer'
import type { TokenMeta } from '../lib/registry'
import { isPinned } from '../lib/pinned'
import { poolFor, readHarvestable, readPools, type Pool } from '../lib/stakingContract'
import { stakingModelFor } from '../lib/staking'
import { explorerToken } from '../lib/chain'
import { readV1FeeWallet, readV1CollectedFees, type V1Collected } from '../lib/ponsV1'
import { LAUNCH_FEE_WALLET } from '../lib/launchPolicy'
import { amount as fmtAmount, shortAddr, usd } from '../lib/format'
import { useToast } from '../lib/toast'
import { Arrow, Check, Copy, External } from '../components/Icons'
import { Empty, StockBadge } from '../components/Ui'

/**
 * One token's dashboard.
 *
 * Everything here is read live: the token's own contract, its pair's reserves and swap events,
 * Blockscout for the stock price, DexScreener for the 24h figures, and the token's published
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
  const [pools, setPools] = useState<Pool[]>([])
  const [harvestable, setHarvestable] = useState<Record<string, bigint>>({})
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [nativeUsd, setNativeUsd] = useState<number | null>(null)
  const [v1Fees, setV1Fees] = useState<V1Collected | null>(null)
  const [v1FeeWallet, setV1FeeWallet] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [broken, setBroken] = useState(false)

  // ⚠ Lowercased before validating. `isAddress` enforces the EIP-55 checksum, so a valid address
  // pasted from a block explorer or a chat message in the wrong case would render "Token not
  // found" — a real address, rejected on presentation. Casing is normalised, then re-checksummed.
  const normalised = raw?.trim().toLowerCase()
  const valid = !!normalised && isAddress(normalised)
  const address = valid ? getAddress(normalised) : null

  /*
    Uncollected V1 fees for this token.

    ⚠⚠ COLLECTED, not uncollected. Nothing on chain stores a lifetime total — `collectFees`
    transfers and zeroes — so this is summed from the locker's `FeesClaimed` events via Blockscout.
    See `readV1CollectedFees` for the 1000-log ceiling.
    ⚠ Only shown when the token's fees actually route to Stake, read live rather than assumed —
    Pons lets a fee wallet be changed, so this is true now, not forever.
  */
  useEffect(() => {
    setV1Fees(null)
    setV1FeeWallet(null)
    if (!address) return
    let cancelled = false
    void readV1FeeWallet(address as Address).then(async (wallet) => {
      if (cancelled || !wallet) return
      setV1FeeWallet(wallet)
      if (wallet.toLowerCase() !== LAUNCH_FEE_WALLET.toLowerCase()) return
      const fees = await readV1CollectedFees(address as Address)
      if (!cancelled) setV1Fees(fees)
    })
    return () => {
      cancelled = true
    }
  }, [address])

  const load = useCallback(async () => {
    if (!address) return
    setError(null)
    try {
      const [t, q, native] = await Promise.all([
        readToken(address),
        fetchQuotes().catch((): Record<string, Quote> => ({})),
        fetchNativeUsd(),
      ])
      setToken(t)
      setQuotes(q)
      setNativeUsd(native)

      // Each of these is independent and none should be able to empty the page.
      void fetchMarketExtras([address]).then((m) => setExtras(m[address.toLowerCase()] ?? null))
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
    // Only the stocks: these are the assets fees can arrive in, and the only ones with a pool to
    // pay. Both reads answer empty until the contract is configured.
    void readHarvestable(STOCKS.filter((s) => s.address).map((s) => s.address as Address)).then(
      setHarvestable,
    )
  }, [])

  /**
   * Staking figures for a LAUNCHED token, which stakes itself into a single pool.
   *
   * ⛔ Not used for the Stake token. Its stakers hold stocks, so there is no single pool and no
   * single unit — the totals live in `stockRows` below, which is where the decimals differ.
   */
  const staking = useMemo(() => {
    if (!token) return { totalStaked: 0n }
    const pool = poolFor(pools, token.address)
    return { totalStaked: pool?.totalStaked ?? 0n }
  }, [pools, token])

  /**
   * Per-stock staking figures for the Stake token's page.
   *
   * ⚠⚠ **Every asset is converted in its OWN decimals.** USDG is 6 where the equities are 18, so
   * adding raw base units across these pools would make a USDG position contribute about 1e-12 of a
   * unit and vanish — and the sum would be in no unit at all. Amounts are formatted per asset here,
   * and the only figure aggregated across them is a USD value.
   */
  const stockRows = useMemo(() => {
    return STOCKS.filter((s) => s.address).map((s) => {
      const pool = poolFor(pools, s.address!)
      const staked = pool?.totalStaked ?? 0n
      const waiting = harvestable[s.address!.toLowerCase()] ?? 0n
      const price = quotes[s.ticker]?.priceUsd ?? null
      const units = Number(staked) / 10 ** s.decimals
      return {
        stock: s,
        staked,
        units,
        waitingUnits: Number(waiting) / 10 ** s.decimals,
        price,
        valueUsd: price != null ? units * price : null,
      }
    })
  }, [pools, harvestable, quotes])

  /**
   * The staked and claimable totals across every stock, in USD.
   *
   * ⚠ A stock holding a real balance whose price could not be read makes the total **unknown**, not
   * smaller: silently omitting it would print a number that looks like a measurement and is short by
   * however much that pool holds. Null renders as a dash.
   */
  const stakedTotalUsd = useMemo(() => {
    if (stockRows.some((r) => r.staked > 0n && r.price == null)) return null
    return stockRows.reduce((sum, r) => sum + (r.valueUsd ?? 0), 0)
  }, [stockRows])

  const waitingTotalUsd = useMemo(() => {
    if (stockRows.some((r) => r.waitingUnits > 0 && r.price == null)) return null
    return stockRows.reduce((sum, r) => sum + (r.price != null ? r.waitingUnits * r.price : 0), 0)
  }, [stockRows])

  const quoteUsd = token?.quoteTicker ? (quotes[token.quoteTicker]?.priceUsd ?? null) : nativeUsd
  /*
    ⚠⚠ Falls back to DexScreener when the pool price cannot be read on chain.

    The chain read covers the pools this app reads directly; a token trading in a Uniswap V3 pool is
    not one of them, so its price arrives only from the market pass. Without this fallback the
    header printed a dashed market cap next to a live 24h move — which reads as broken rather than
    as a missing source. ⚠ Still null when neither source has a price: a dash is honest, an invented
    market cap is not.
  */
  const priceUsd =
    (token && token.priceQuote !== null && quoteUsd !== null ? token.priceQuote * quoteUsd : null) ??
    extras?.priceUsd ??
    null
  const supply = token ? Number(token.totalSupply) / 10 ** token.decimals : null
  /*
    Both fee sides in one number. Requires the token's own USD price AND the native price, so it is
    null whenever either is missing rather than silently reporting one side as the whole.
  */
  const feesTotalUsd = useMemo(() => {
    if (!v1Fees || !token || priceUsd === null || nativeUsd === null) return null
    const tokenUsd = (Number(v1Fees.token) / 10 ** token.decimals) * priceUsd
    const ethUsd = (Number(v1Fees.eth) / 1e18) * nativeUsd
    return tokenUsd + ethUsd
  }, [v1Fees, token, priceUsd, nativeUsd])
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
              ? `Trading ${BRAND.name} pays a tax which funds everyone staking a stock.`
              : 'Trading this token pays a tax which funds its stakers.'}
          </p>
        </div>

        {/*
          Fees this token has earned and not yet collected.

          ⚠⚠ **Uncollected, not lifetime.** Collecting sets it to zero, so this must never be
          labelled as total earnings — the chain keeps no cumulative figure and one cannot be
          reconstructed (the RPC caps `eth_getLogs` at 2,000 blocks).
          ⚠ Shown only when the fee route is Stake's, read live. `null` means the read itself
          failed and renders a dash rather than a confident zero.
        */}
        {v1FeeWallet && v1FeeWallet.toLowerCase() === LAUNCH_FEE_WALLET.toLowerCase() && (
          <>
            <div className="grid grid-3">
              <Stat
                label={`In ${token.symbol}`}
                value={v1Fees === null ? '—' : `${fmtAmount(Number(v1Fees.token) / 10 ** token.decimals)} ${token.symbol}`}
                sub="collected to date"
              />
              <Stat
                label="In ETH"
                value={v1Fees === null ? '—' : `${fmtAmount(Number(v1Fees.eth) / 1e18)} ETH`}
                sub={
                  v1Fees && nativeUsd !== null
                    ? usd((Number(v1Fees.eth) / 1e18) * nativeUsd)
                    : undefined
                }
              />
              {/*
                The two sides added together.

                ⚠ Null unless BOTH prices are known. Adding only the side that happens to have a
                price would print a total short by the other, while looking like a measurement — the
                same failure the staked totals avoid. A dash says "not known", which is true.
              */}
              <Stat
                label="Total"
                value={feesTotalUsd !== null ? usd(feesTotalUsd) : '—'}
                sub={feesTotalUsd !== null ? 'collected to date, in USD' : undefined}
              />
            </div>
          </>
        )}
      </section>

      {/* ---------------------------------- staking ----------------------------------
          Two genuinely different products, not two skins on one. See `lib/staking.ts`. */}
      {model === 'pstake' ? (
        <section className="section">
          <div className="section-head section-head-center">
            <h2>Staking</h2>
            {/* ✏️ This said "{BRAND.name} itself is not staked", which stopped being true when the
                $STAKE pool was added. Corrected rather than reworded — see `lib/staking.ts`. */}
            <p>
              Stake any stock to earn from {BRAND.name}'s trading fees, or stake {BRAND.name} itself
              to earn more of it.
            </p>
          </div>

          {/*
            ⛔ A staker COUNT and a lifetime "rewards distributed" used to sit here as literal
            zeroes. Neither can be read: the contract does not enumerate stakers, it keeps no
            cumulative payout, and this chain's 2,000-block log cap rules out reconstructing either
            by scanning. A hard-coded zero is not a placeholder once pools hold money — it is a
            wrong number stated confidently. What replaced them is read from the contract.
          */}
          {/* ⚠ Two stats in a THREE column grid left an empty third cell, so the pair hugged the
              left while the table below ran the full width. */}
          <div className="grid grid-2">
            <Stat
              label="Total staked"
              value={stakedTotalUsd !== null ? usd(stakedTotalUsd, { compact: true }) : '—'}
              sub="across every stock"
            />
            <Stat
              label="Waiting to be paid out"
              value={waitingTotalUsd !== null ? usd(waitingTotalUsd, { compact: true }) : '—'}
              sub="claimable by stakers"
            />
          </div>

          <div className="table-wrap" style={{ marginTop: 22 }}>
            <table>
              <thead>
                <tr>
                  <th>Stock</th>
                  <th className="right">Price</th>
                  <th className="right">Total staked</th>
                  <th className="right">Waiting</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {stockRows.map((r) => (
                  <tr key={r.stock.ticker}>
                    <td>
                      <div className="tk">
                        <StockBadge ticker={r.stock.ticker} to={false} />
                        <span className="tk-sub">{r.stock.company}</span>
                      </div>
                    </td>
                    <td className="right mono">{r.price != null ? usd(r.price) : '—'}</td>
                    <td className="right mono">
                      {fmtAmount(r.units)}
                      {r.valueUsd !== null && r.units > 0 && (
                        <div className="tk-sub">{usd(r.valueUsd, { compact: true })}</div>
                      )}
                    </td>
                    <td className="right mono">{fmtAmount(r.waitingUnits)}</td>
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

          {/* The other side of the same page: the table above stakes stocks, this stakes the token
              itself. Both land on /stake, which is where positions are opened. */}
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 22 }}>
            <Link className="btn btn-primary" to="/stake">
              Stake {BRAND.pinned.symbol} <Arrow />
            </Link>
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
              // This branch is a launched token staked into its own pool, so the stake asset IS this
              // token and its decimals are the right ones to divide by.
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
