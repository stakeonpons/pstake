import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { formatUnits, parseUnits, type Address } from 'viem'
import { BRAND, LOCK_TIERS } from '../brand'
import { Arrow, Lock, Mark, Wallet } from '../components/Icons'
import { Empty, Notice, StockBadge } from '../components/Ui'
import { useWallet, useWrongChain } from '../lib/wallet'
import { buildRegistry, type RegistryToken } from '../lib/registry'
import { PREVIEW_BALANCES, previewOn } from '../lib/preview'
import {
  ensureAllowance,
  poolFor,
  readPools,
  readStakingOpen,
  sendStake,
  type Pool,
} from '../lib/stakingContract'
import { publicClient } from '../lib/chain'
import { isStakeable } from '../lib/staking'
import { fetchNativeUsd, readBalances } from '../lib/ponsIndexer'
import { STOCKS, fetchQuotes, type Quote } from '../lib/stocks'
import { amount as fmtAmount, usd } from '../lib/format'

/**
 * Two things can be staked here, and they are paid from completely different pots.
 *
 *  - `stock`  — a stock. Rewards come from **the Stake token's own fees**, which are used to buy
 *                stocks and split across everyone staking one.
 *  - `token`   — a token launched through Stake. Rewards come from **that token's own trading
 *                fees**, paid in the single stock it was paired against.
 *
 * They must not be presented as one pool: the reward source, and therefore the risk, is different.
 */
type StakeState =
  | { kind: 'idle' }
  | { kind: 'approving' }
  | { kind: 'signing' }
  | { kind: 'confirming' }
  | { kind: 'done'; amount: number; symbol: string; days: number }
  | { kind: 'error'; message: string }

type Holding = {
  kind: 'stock' | 'token'
  address: Address
  symbol: string
  name: string
  decimals: number
  balance: bigint
  balanceFloat: number
  priceUsd: number | null
  /** The stock a launched token pays out. Null for stocks, which pay out in stocks generally. */
  reward: string | null
}

/**
 * Staged holdings for `?preview=1`.
 *
 * Not part of the published build.
 */
function previewHoldings(listed: RegistryToken[], quotes: Record<string, Quote>): Holding[] {
  const stocks: Holding[] = STOCKS.filter((s) => s.address && PREVIEW_BALANCES[s.ticker]).map((s) => {
    const bal = PREVIEW_BALANCES[s.ticker]
    return {
      kind: 'stock',
      address: s.address as Address,
      symbol: s.ticker,
      name: s.company,
      decimals: s.decimals,
      balance: BigInt(Math.round(bal * 10 ** s.decimals)),
      balanceFloat: bal,
      priceUsd: quotes[s.ticker]?.priceUsd ?? null,
      reward: null,
    }
  })

  const tokens: Holding[] = listed
    .filter((t) => isStakeable(t.address))
    .filter((t) => PREVIEW_BALANCES[t.symbol])
    .map((t) => {
      const bal = PREVIEW_BALANCES[t.symbol]
      return {
        kind: 'token',
        address: t.address,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        balance: BigInt(Math.round(bal)) * 10n ** BigInt(t.decimals),
        balanceFloat: bal,
        priceUsd: t.priceUsd,
        reward: t.reward,
      }
    })

  return [...stocks, ...tokens]
}

export default function Stake() {
  const { connected, address, openPicker, provider } = useWallet()
  const wrongChain = useWrongChain()
  const preview = previewOn()

  const [holdings, setHoldings] = useState<Holding[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [selected, setSelected] = useState<string | null>(null)
  const [raw, setRaw] = useState('')
  const [days, setDays] = useState(30)
  const [pools, setPools] = useState<Pool[]>([])
  /** Null while unknown or unconfigured; `false` is an explicit "closed", which the form obeys. */
  const [stakingOpen, setStakingOpen] = useState<boolean | null>(null)
  const [stakeState, setStakeState] = useState<StakeState>({ kind: 'idle' })

  const load = useCallback(async () => {
    if (!address && !preview) return
    setLoading(true)
    setError(null)
    try {
      const [nativeUsd, quotes] = await Promise.all([fetchNativeUsd(), fetchQuotes().catch((): Record<string, Quote> => ({}))])
      const listed = await buildRegistry(nativeUsd, quotes)

      const stockHoldings = STOCKS.filter((s) => s.address)
      // One balance sweep across both sets, so it is a single batched round trip. Skipped entirely
      // when previewing without a wallet, since there is no address to read.
      const balances = address
        ? await readBalances(address as Address, [
            ...stockHoldings.map((s) => s.address as Address),
            ...listed.map((t) => t.address),
          ])
        : {}
      const held = (addr: string) => balances[addr.toLowerCase()] ?? 0n

      const found: Holding[] = [
        ...stockHoldings
          .filter((s) => held(s.address!) > 0n)
          .map((s) => ({
            kind: 'stock' as const,
            address: s.address as Address,
            symbol: s.ticker,
            name: s.company,
            decimals: s.decimals,
            balance: held(s.address!),
            balanceFloat: Number(held(s.address!)) / 10 ** s.decimals,
            priceUsd: quotes[s.ticker]?.priceUsd ?? null,
            reward: null,
          })),
        ...listed
          // ⛔ The Stake token is deliberately absent. Its model is the reverse: you stake a
          // stock and earn from ITS fees, so offering it here would contradict the product. See
          // `lib/staking.ts`.
          .filter((t) => isStakeable(t.address))
          .filter((t) => held(t.address) > 0n)
          .map((t) => ({
            kind: 'token' as const,
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            balance: held(t.address),
            balanceFloat: Number(held(t.address)) / 10 ** t.decimals,
            priceUsd: t.priceUsd,
            reward: t.reward,
          })),
      ]
      // Preview substitutes balances only when there are genuinely none to show, so a wallet that
      // really does hold a stock still sees its own position rather than a staged one.
      setHoldings(preview && !found.length ? previewHoldings(listed, quotes) : found)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read your balances.')
      setHoldings([])
    } finally {
      setLoading(false)
    }
  }, [address, preview])

  useEffect(() => {
    if (connected || preview) void load()
    else setHoldings(null)
  }, [connected, preview, load])

  useEffect(() => {
    void readPools().then(setPools)
    void readStakingOpen().then(setStakingOpen)
  }, [])

  const busy =
    stakeState.kind === 'approving' || stakeState.kind === 'signing' || stakeState.kind === 'confirming'

  /**
   * Approves if needed, then stakes.
   *
   * ⚠ The approval is awaited to confirmation before the stake is sent. The stake pulls the tokens,
   * so sending both at once means the second races the first and reverts, which a staker reads as
   * the site being broken rather than as a sequencing problem.
   */
  async function submitStake() {
    if (!token || !provider || !address || !amt) return
    const pool = poolFor(pools, token.address)
    if (!pool) {
      setStakeState({ kind: 'error', message: 'That asset cannot be staked right now.' })
      return
    }

    // Tracked so the failure message can tell the truth. An approval that has already confirmed is
    // a signed transaction that cost gas, and telling somebody nothing was signed after they watched
    // their wallet do it reads as the site lying about their money.
    let approvedOnChain = false

    try {
      const value = parseUnits(raw.replace(/,/g, '').trim(), token.decimals)

      setStakeState({ kind: 'approving' })
      const approval = await ensureAllowance(
        { token: token.address, owner: address as Address, amount: value },
        provider,
      )
      if (approval) {
        await publicClient.waitForTransactionReceipt({ hash: approval })
        approvedOnChain = true
      }

      setStakeState({ kind: 'signing' })
      const hash = await sendStake(
        { poolId: pool.id, amount: value, termDays: days, from: address as Address },
        provider,
      )

      setStakeState({ kind: 'confirming' })
      await publicClient.waitForTransactionReceipt({ hash })

      setStakeState({ kind: 'done', amount: amt, symbol: token.symbol, days })
      setRaw('')
      void load()
    } catch (err) {
      // A wallet rejection is the common case and is not an error worth alarming anybody about.
      const message = err instanceof Error ? err.message : String(err)
      const cancelled = /reject|denied|User denied/i.test(message)
      setStakeState({
        kind: 'error',
        message: /BelowMinimum/.test(message)
          ? `That is under this pool's minimum. Stake at least ${fmtAmount(minStakeFloat)} ${token.symbol}.`
          : /StakingClosed/.test(message)
            ? 'Staking is closed right now, so nothing was staked.'
            : cancelled
              ? approvedOnChain
                ? 'The stake was cancelled in your wallet. Your approval went through, so nothing left your wallet and you can try again without approving twice.'
                : 'That was cancelled in your wallet, so nothing was signed.'
              : approvedOnChain
                ? 'The stake did not go through. Your approval confirmed, but no tokens left your wallet — try again in a moment.'
                : 'Nothing was signed and nothing left your wallet. Try again in a moment.',
      })
    }
  }

  const token = useMemo(
    () => holdings?.find((h) => h.address === selected) ?? holdings?.[0] ?? null,
    [holdings, selected],
  )

  const parsed = Number(raw.replace(/,/g, ''))
  const amt = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  const overBalance = token ? amt > token.balanceFloat : false
  const valueUsd = token?.priceUsd != null ? amt * token.priceUsd : null

  const pool = token ? poolFor(pools, token.address) : null

  /**
   * The pool's floor, in the asset's own units.
   *
   * ⚠⚠ Checked here because the contract checks it too: `stake` reverts `BelowMinimum` under it. The
   * floor is a whole unit — one NVDA, one SPY — so entering a fraction is an ordinary thing to do,
   * and without this the page takes an approval, spends the gas, and only then fails the stake it
   * was for.
   */
  const minStakeFloat = pool && token && pool.minStake > 0n ? Number(formatUnits(pool.minStake, token.decimals)) : 0
  const belowMin = amt > 0 && minStakeFloat > 0 && amt < minStakeFloat

  const stockHoldings = holdings?.filter((h) => h.kind === 'stock') ?? []
  const tokens = holdings?.filter((h) => h.kind === 'token') ?? []

  // Preview deliberately skips both gates: the whole point is to see the page without a wallet.
  if (!connected && !preview) {
    return (
      <Shell>
        <div className="card empty" style={{ padding: '56px 24px' }}>
          <div className="ico">
            <Mark size={30} />
          </div>
          <h3>Staking</h3>
          <p>Connect your wallet to start staking.</p>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
            <button className="btn btn-primary" onClick={openPicker}>
              <Wallet /> Connect Wallet
            </button>
          </div>
        </div>
        <Durations />
      </Shell>
    )
  }

  if (wrongChain && !preview) {
    return (
      <Shell>
        <Empty
          title={`Switch to ${BRAND.chain}`}
          body="Your wallet is on another network, so your balances cannot be read."
        />
        <Durations />
      </Shell>
    )
  }

  if (loading && !holdings) {
    return (
      <Shell>
        <div className="card empty" style={{ padding: '56px 24px' }}>
          <div className="spinner" />
          <h3 style={{ marginTop: 18 }}>Checking your wallet</h3>
          <p>Looking for stocks and {BRAND.name} tokens you can stake.</p>
        </div>
        <Durations />
      </Shell>
    )
  }

  if (!holdings?.length) {
    return (
      <Shell>
        <Empty
          title="No stakable tokens"
          body={error ?? 'You do not hold any stakable tokens.'}
          action={
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link className="btn btn-primary" to="/stocks">
                Browse stocks <Arrow />
              </Link>
              <Link className="btn btn-ghost" to="/tokens">
                Browse tokens
              </Link>
            </div>
          }
        />
        <Durations />
      </Shell>
    )
  }

  return (
    <Shell>
      <div className="card">
        <div className="field">
          {stockHoldings.length > 0 && (
            <>
              <div className="holding-group">Stocks</div>
              <div className="holding-list">
                {stockHoldings.map((h) => (
                  <HoldingRow key={h.address} h={h} on={token?.address === h.address} onPick={pick} />
                ))}
              </div>
            </>
          )}

          {tokens.length > 0 && (
            <>
              <div className="holding-group" style={{ marginTop: stockHoldings.length ? 18 : 0 }}>
                {BRAND.name} tokens
              </div>
              <div className="holding-list">
                {tokens.map((h) => (
                  <HoldingRow key={h.address} h={h} on={token?.address === h.address} onPick={pick} />
                ))}
              </div>
            </>
          )}
        </div>

        {token && (
          <>
            <div className="field">
              <div className="field-label">
                <span>Amount</span>
                <b className="mono">
                  Balance: {fmtAmount(token.balanceFloat)} {token.symbol}
                </b>
              </div>
              <div className="amount-input">
                <input
                  inputMode="decimal"
                  value={raw}
                  onChange={(e) => {
                    setRaw(e.target.value.replace(/[^0-9.,]/g, ''))
                    setStakeState({ kind: 'idle' })
                  }}
                  placeholder="0"
                />
                {/*
                  ⚠ Formatted from the balance in base units, NOT from `balanceFloat`. That float is
                  a double, so an 18-decimal balance does not survive it: usually it rounds down and
                  MAX quietly leaves dust unstaked, and sometimes it rounds UP — a balance of
                  0.999999999999999999 becomes exactly 1, which is more than the wallet holds, so the
                  transfer reverts. `formatUnits` is exact and `parseUnits` puts it back unchanged.
                */}
                <button className="max-btn" onClick={() => setRaw(formatUnits(token.balance, token.decimals))}>
                  MAX
                </button>
              </div>
              {overBalance ? (
                <p className="field-error">That is more than your {token.symbol} balance.</p>
              ) : belowMin ? (
                <p className="field-error">
                  The smallest stake this pool takes is {fmtAmount(minStakeFloat)} {token.symbol}.
                </p>
              ) : (
                valueUsd !== null && amt > 0 && (
                  <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
                    ≈ {usd(valueUsd)}
                  </p>
                )
              )}
            </div>

            <div className="field">
              <div className="field-label">
                <span>Lock duration</span>
                <b>
                  Unlocks{' '}
                  {new Date(Date.now() + days * 864e5).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </b>
              </div>
              <div className="mult-grid">
                {LOCK_TIERS.map((t) => (
                  <button
                    key={t.days}
                    className={`mult mult-duration ${t.days === days ? 'on' : ''}`}
                    onClick={() => {
                      setDays(t.days)
                      setStakeState({ kind: 'idle' })
                    }}
                  >
                    <div className="m mono">{t.days}</div>
                    <div className="d">{t.days === 1 ? 'day' : 'days'}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="summary" style={{ marginBottom: 20 }}>
              <div className="summary-row">
                <span className="k">You stake</span>
                <span className="v">{amt ? `${fmtAmount(amt)} ${token.symbol}` : '—'}</span>
              </div>
              <div className="summary-row">
                <span className="k">You earn</span>
                <span className="v" style={{ fontFamily: 'var(--font)' }}>
                  {token.kind === 'stock' ? (
                    'Stocks'
                  ) : token.reward ? (
                    <StockBadge ticker={token.reward} to={false} />
                  ) : (
                    'Its paired stock'
                  )}
                </span>
              </div>
              <div className="summary-row">
                <span className="k">Paid from</span>
                <span className="v" style={{ fontFamily: 'var(--font)' }}>
                  {token.kind === 'stock' ? `${BRAND.name} token fees` : `${token.symbol} trading fees`}
                </span>
              </div>
              <div className="summary-row">
                <span className="k">Locked for</span>
                <span className="v">
                  {days} {days === 1 ? 'day' : 'days'}
                </span>
              </div>
            </div>

            {stakingOpen === false && (
              <div style={{ marginBottom: 16 }}>
                <Notice>Staking is closed right now, so this pool is not taking deposits.</Notice>
              </div>
            )}

            <button
              className="btn btn-primary btn-lg btn-block"
              disabled={!amt || overBalance || belowMin || stakingOpen === false || busy}
              onClick={() => void submitStake()}
            >
              <Lock size={17} />
              {stakingOpen === false
                ? 'Staking is closed'
                : stakeState.kind === 'approving'
                ? `Approve ${token.symbol} in your wallet…`
                : stakeState.kind === 'signing'
                  ? 'Confirm in your wallet…'
                  : stakeState.kind === 'confirming'
                    ? 'Locking…'
                    : amt
                      ? `Stake ${fmtAmount(amt)} ${token.symbol}`
                      : 'Enter an amount'}
            </button>

            {stakeState.kind === 'done' && (
              <div className="alert alert-block alert-center">
                <div>
                  <b>
                    {fmtAmount(stakeState.amount)} {stakeState.symbol} locked for {stakeState.days}{' '}
                    {stakeState.days === 1 ? 'day' : 'days'}
                  </b>
                  <p>
                    Rewards accrue from now and can be claimed at any time. Your position is on the{' '}
                    <Link to="/rewards">Rewards page</Link>.
                  </p>
                </div>
              </div>
            )}

            {stakeState.kind === 'error' && (
              <div className="alert alert-block alert-center">
                <div>
                  <b>Could not submit that stake</b>
                  <p>{stakeState.message}</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <Durations />
    </Shell>
  )

  function pick(h: Holding) {
    setSelected(h.address)
    setRaw('')
    setStakeState({ kind: 'idle' })
  }
}

/* ------------------------------------------------------------------ */

function HoldingRow({ h, on, onPick }: { h: Holding; on: boolean; onPick: (h: Holding) => void }) {
  return (
    <button className={`holding ${on ? 'on' : ''}`} onClick={() => onPick(h)}>
      <span className="tk-glyph mono" style={{ fontSize: 13, fontWeight: 700 }}>
        {h.symbol.slice(0, 2).toUpperCase()}
      </span>
      <span className="holding-name">
        <b>{h.symbol}</b>
        <span className="tk-sub">{h.name}</span>
      </span>
      {h.reward && <StockBadge ticker={h.reward} to={false} />}
      <span className="holding-bal mono">{fmtAmount(h.balanceFloat)}</span>
    </button>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Stake</h1>
        <p>Lock a token and start earning stocks.</p>
      </div>      {children}
    </div>
  )
}

function Durations() {
  return (
    <section className="section">
      <div className="section-head section-head-center">
        <h2>Lock durations</h2>
        <p>
          Reward weight increases with longer lock durations, multipliers are calculated
          automatically by the yield calculator.
        </p>
      </div>

      <div className="mult-grid">
        {LOCK_TIERS.map((t) => (
          <div className={`mult mult-duration ${t.days === 30 ? 'on' : ''}`} key={t.days}>
            <div className="m mono">{t.days}</div>
            <div className="d">{t.days === 1 ? 'day' : 'days'}</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20 }}>
        <Notice>
          Locks cannot be unlocked early, which is what gives reward weight its meaning. Rewards
          accrue for the full term and stay claimable.
        </Notice>
      </div>
    </section>
  )
}
