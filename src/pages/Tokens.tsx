import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { BRAND } from '../brand'
import { STOCKS, fetchQuotes } from '../lib/stocks'
import { buildRegistry, enrichWithMeta, removeManual, type RegistryToken } from '../lib/registry'
import { fetchNativeUsd } from '../lib/ponsIndexer'
import { age } from '../lib/market'
import { explorerToken } from '../lib/chain'
import { isAdminAddress, isUnconfiguredAdmin, signAdminAction } from '../lib/admin'
import { removeToken } from '../lib/registryApi'
import { useWallet } from '../lib/wallet'
import { shortAddr, usd } from '../lib/format'
import { useToast } from '../lib/toast'
import { Arrow, Check, Copy, External, Info, Plus, Search } from '../components/Icons'
import { Empty, PreviewBanner, StockBadge } from '../components/Ui'
import { previewOn } from '../lib/preview'
import AddTokenModal from '../components/AddTokenModal'

type SortKey = 'mcapUsd' | 'newest'

export default function Tokens() {
  const [params, setParams] = useSearchParams()
  const { address, provider } = useWallet()
  const admin = isAdminAddress(address)
  const toast = useToast()

  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('newest')
  const [rows, setRows] = useState<RegistryToken[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)

  const rewardOptions = useMemo(() => STOCKS.map((s) => s.ticker), [])
  const rewardParam = params.get('reward')
  const reward = rewardParam && rewardOptions.includes(rewardParam) ? rewardParam : 'all'

  function setReward(next: string) {
    if (next === 'all') params.delete('reward')
    else params.set('reward', next)
    setParams(params, { replace: true })
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Both are needed: the native rate prices anything not paired against a stock, the stock
      // quotes price the rest.
      const [price, quotes] = await Promise.all([fetchNativeUsd(), fetchQuotes().catch(() => ({}))])
      const built = await buildRegistry(price, quotes)
      setRows(built)

      // Artwork arrives afterwards — it costs a block search per token, and the cards are already
      // readable without it. Each result is merged as it lands rather than waiting for the slowest.
      void enrichWithMeta(built, (address, meta) => {
        setRows((prev) =>
          prev?.map((r) => (r.address.toLowerCase() === address.toLowerCase() ? { ...r, meta } : r)) ?? prev,
        )
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach Robinhood Chain.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Removes a token from the shared registry, and from this browser's local list.
   *
   * ⚠ The local list alone is not enough: anything the server is serving would return on the next
   * load, for everyone. The server needs a signature it can recover to an admin wallet, which is the
   * real access control — `admin.ts` on the front end is only a UI gate.
   */
  const remove = useCallback(
    async (t: RegistryToken) => {
      removeManual(t.address)

      if (t.source === 'shared' || t.source === 'launch') {
        if (!provider || !address) {
          toast.show('Connect the admin wallet to remove this')
          return
        }
        try {
          const signed = await signAdminAction(provider, address, `remove ${t.address}`)
          const ok = await removeToken(t.address, { address, ...signed })
          if (!ok) {
            toast.show('Could not remove that token')
            return
          }
        } catch {
          toast.show('Could not remove that token')
          return
        }
      }

      setRows((prev) => prev?.filter((r) => r.address !== t.address) ?? null)
      toast.show(`${t.symbol} removed`)
    },
    [provider, address, toast],
  )

  const filtered = useMemo(() => {
    if (!rows) return []
    const needle = q.trim().toLowerCase()

    // The Stake token is exempt from filtering and sorting: it is the platform's own token, so it
    // leads the grid whatever the visitor has typed or selected. Pulled out first, prepended last.
    const pin = rows.find((t) => t.source === 'pinned')

    const rest = rows
      .filter((t) => t.source !== 'pinned')
      .filter((t) => {
        if (reward !== 'all' && t.reward !== reward) return false
        if (!needle) return true
        return (
          t.symbol.toLowerCase().includes(needle) ||
          t.name.toLowerCase().includes(needle) ||
          t.address.toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => {
        // Pair creation time, not block number: only scanned rows carry a launch event, so the old
        // key sorted every manually added token as equally old.
        if (sort === 'newest') {
          return (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
        }
        return (b[sort] ?? -1) - (a[sort] ?? -1)
      })

    return pin ? [pin, ...rest] : rest
  }, [rows, q, reward, sort])

  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Tokens</h1>
        <p>Staking enabled tokens launched through {BRAND.name}.</p>
      </div>

      {previewOn() && (
        <PreviewBanner simulated={`The ${BRAND.name} card shows the real pinned layout, with figures borrowed from a live contract so it can be reviewed populated. The rest are real Pons tokens paired against a stock, read from chain, and are not ${BRAND.name} listings.`} />
      )}

      {isUnconfiguredAdmin(address) && (
        <div className="alert alert-block" style={{ marginBottom: 20 }}>
          <Info />
          <div>
            <b>Admin controls are open because no admin wallet is configured</b>
            <p>
              Set <code>adminWallets</code> in <code>src/brand.ts</code> to your address. Until you
              do, these controls show in <code>npm run dev</code> only, never in a production build.
            </p>
          </div>
        </div>
      )}

      <div className="toolbar">
        <label className="search">
          <Search />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, ticker or contract address"
          />
        </label>

        <select className="select" value={reward} onChange={(e) => setReward(e.target.value)}>
          <option value="all">All rewards</option>
          {rewardOptions.map((t) => (
            <option key={t} value={t}>
              Pays {t}
            </option>
          ))}
        </select>

        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="newest">Sort: Newest</option>
          <option value="mcapUsd">Sort: Market cap</option>
        </select>

        {admin && (
          <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
            <Plus size={16} /> Add token
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error" style={{ marginBottom: 20 }}>
          <Info />
          <div>
            <b>Could not read the chain</b>
            <p>{error}</p>
          </div>
        </div>
      )}

      {loading && !rows ? (
        <div className="card empty">
          <div className="spinner" />
          <h3 style={{ marginTop: 18 }}>Reading {BRAND.chain}…</h3>
          <p>Scanning launch events and pool reserves.</p>
        </div>
      ) : filtered.length === 0 ? (
        <Empty
          title={rows?.length ? 'No tokens match' : 'No tokens listed'}
          body={
            rows?.length
              ? 'Try a different filter, or clear the search.'
              : admin
                ? 'Launch a token through Stake, or add an existing one by contract address.'
                : 'Tokens launched through Stake appear here.'
          }
          action={
            admin ? (
              <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
                <Plus size={16} /> Add a token
              </button>
            ) : (
              <Link className="btn btn-primary" to="/launch">
                Launch a token <Arrow />
              </Link>
            )
          }
        />
      ) : (
        // No explanatory footnote under the grid — the cards state their own numbers. Do not add
        // one back.
        <div className="token-grid">
          {filtered.map((t) => (
            <TokenCard
              key={t.address}
              t={t}
              admin={admin}
              onRemove={() => void remove(t)}
            />
          ))}
        </div>
      )}

      <AddTokenModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={() => {
          setAddOpen(false)
          void load()
        }}
      />
    </div>
  )
}

/**
 * One token, as a card.
 *
 * Ordered by what a reader actually scans for: the artwork identifies it, the market cap is the
 * number they came for, and the plumbing — contract address, source, links — sits underneath in a
 * quieter row. Everything shown is read from chain or from the token's own published metadata; a
 * value that cannot be read renders a dash rather than a zero.
 */
function TokenCard({ t, admin, onRemove }: { t: RegistryToken; admin: boolean; onRemove: () => void }) {
  const navigate = useNavigate()
  const [copied, setCopied] = useState(false)
  const [broken, setBroken] = useState(false)
  const toast = useToast()
  const image = broken ? null : (t.meta?.imageUrl ?? null)
  const ageLabel = age(t.createdAtMs)
  const change = t.change24h
  const pinned = t.source === 'pinned'

  async function copy() {
    // `writeText` rejects outright in a few real situations — an insecure origin, a browser that
    // withholds the permission, an unfocused document. Confirming a copy that did not happen is
    // worse than not confirming one, so the toast waits for the write to actually resolve.
    try {
      await navigator.clipboard.writeText(t.address)
    } catch {
      toast.show('Could not copy the address')
      return
    }
    setCopied(true)
    toast.show(`${t.symbol} contract address copied`)
    setTimeout(() => setCopied(false), 1400)
  }

  return (
    // The whole card opens the token's page. Copying moved to the address chip in the footer, so
    // both actions are still one click and neither shadows the other.
    <article
      className={`tcard${pinned ? ' tcard-pinned' : ''}`}
      role="link"
      tabIndex={0}
      title={`${t.name} details`}
      onClick={() => navigate(`/token/${t.address}`)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          navigate(`/token/${t.address}`)
        }
      }}
    >
      <div className="tcard-art">
        {image ? (
          // Cross-origin images load without CORS; a host that 404s or hotlink-blocks falls back.
          <img src={image} alt="" loading="lazy" onError={() => setBroken(true)} />
        ) : (
          <span className="tcard-mono mono">{t.symbol.slice(0, 3).toUpperCase()}</span>
        )}

        <div className="tcard-tags">
          {pinned && <span className="tcard-tag tcard-tag-hi">{BRAND.name}</span>}
          {ageLabel && <span className="tcard-tag">{ageLabel}</span>}
          {t.source === 'launch' && <span className="tcard-tag tcard-tag-hi">Launched here</span>}
        </div>

        {/* The pinned Stake token is never shown a reward ticker: it is not paired against a
            stock, so a badge there would name an asset it has nothing to do with. */}
        {t.reward && !pinned && (
          <div className="tcard-reward">
            <StockBadge ticker={t.reward} to={false} />
          </div>
        )}
      </div>

      <div className="tcard-body">
        <div className="tcard-title">
          <span className="tcard-name" title={t.name}>
            {t.name}
          </span>
          <span className="tcard-sym mono">{t.symbol}</span>
        </div>

        <div className="tcard-figure">
          <span className="tcard-mcap">
            {t.mcapUsd !== null ? usd(t.mcapUsd, { compact: true }) : <span className="muted">—</span>}
          </span>
          {change !== null ? (
            <span className={`tcard-chg ${change >= 0 ? 'up' : 'down'}`}>
              {change >= 0 ? '▲' : '▼'} {Math.abs(change).toFixed(1)}%
            </span>
          ) : (
            <span className="tcard-chg muted">—</span>
          )}
        </div>
        <div className="tcard-figure-label">
          Market cap<span>24h</span>
        </div>

        {/* No price / liquidity / volume row. Market cap and the 24h move are the card; the rest is
            detail nobody scanning a grid needs. Do not add it back. */}

        <div className="tcard-foot">
          {/* Stops the card's navigation so the chip copies rather than opening the page. */}
          <button
            className="tcard-ca mono"
            title={`Copy ${t.address}`}
            onClick={(e) => {
              e.stopPropagation()
              void copy()
            }}
          >
            {shortAddr(t.address)} {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>

          {/* Every link stops the click here so it opens instead of copying the address. */}
          <div className="tcard-links" onClick={(e) => e.stopPropagation()}>
            {t.meta?.twitter && (
              <a href={t.meta.twitter} target="_blank" rel="noreferrer" title="X">
                x
              </a>
            )}
            {t.meta?.telegram && (
              <a href={t.meta.telegram} target="_blank" rel="noreferrer" title="Telegram">
                tg
              </a>
            )}
            {t.meta?.website && (
              <a href={t.meta.website} target="_blank" rel="noreferrer" title="Website">
                web
              </a>
            )}
            <a href={explorerToken(t.address)} target="_blank" rel="noreferrer" title="Blockscout">
              <External size={12} />
            </a>
            {admin && t.source === 'manual' && (
              <button onClick={onRemove} title="Remove from the registry">
                remove
              </button>
            )}
          </div>
        </div>
      </div>
    </article>
  )
}
