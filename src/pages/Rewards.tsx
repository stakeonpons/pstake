import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Address } from 'viem'
import { Arrow, Mark, Wallet } from '../components/Icons'
import { Notice, StockBadge } from '../components/Ui'
import { useWallet } from '../lib/wallet'
import { useToast } from '../lib/toast'
import { buildClaim, readClaimable, type ClaimableRow } from '../lib/fees'
import {
  readPoolAssets,
  readPools,
  readPositions,
  sendClaim,
  sendWithdraw,
  type AssetMeta,
  type Pool,
  type Position,
} from '../lib/stakingContract'
import { fetchQuotes, type Quote } from '../lib/stocks'
import { amount as fmtAmount, usd } from '../lib/format'

/**
 * Claimable rewards.
 *
 * ⭐ Real numbers, read from Pons's fee escrow — `balanceOfToken(you, stock)`. On BNB this page had
 * nothing on-chain to show, because flap accrued fees inside a liquidity position and exposed only
 * a cumulative total; here the escrow holds a per-asset balance the owner can withdraw, so what is
 * displayed is exactly what a claim would pay out.
 *
 * ⚠ A balance here is CLAIMABLE, not LIFETIME. Claiming zeroes it. Nothing on this page may call it
 * "earned" or "total" — those would be different, larger numbers that this contract does not keep.
 *
 * ⚠ Copy rule: nothing describes the product as unbuilt or forthcoming. An empty state is written
 * as an empty state ("nothing to claim"), never as "not available yet".
 */
export default function Rewards() {
  const { connected, address, provider, openPicker } = useWallet()
  const toast = useToast()

  const [rows, setRows] = useState<ClaimableRow[] | null>(null)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [claiming, setClaiming] = useState<string | null>(null)

  const [positions, setPositions] = useState<Position[]>([])
  const [pools, setPools] = useState<Pool[]>([])
  const [assets, setAssets] = useState<Record<string, AssetMeta>>({})
  const [working, setWorking] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!address) {
      setRows(null)
      setPositions([])
      return
    }
    const [claimable, q] = await Promise.all([
      readClaimable(address as Address).catch(() => null),
      fetchQuotes().catch(() => ({}) as Record<string, Quote>),
    ])
    setQuotes(q)
    // Only rows with something in them. A table of zeroes is noise, not information.
    setRows(claimable ? claimable.rows.filter((r) => r.amount > 0n) : [])

    // Positions are a separate pot from the escrow above and are read separately: the escrow holds
    // what THIS wallet is owed as a token's creator, while a stake's rewards sit in the staking
    // contract until claimed. Both are empty until the contract is configured, and both fail soft.
    const ps = await readPools()
    setPools(ps)
    const [open, meta] = await Promise.all([readPositions(address as Address, ps), readPoolAssets(ps)])
    setPositions(open)
    setAssets(meta)
  }, [address])

  useEffect(() => {
    void load()
  }, [load])

  async function claim(row: ClaimableRow) {
    if (!provider || !address) return
    try {
      setClaiming(row.ticker)
      const tx = buildClaim(row.address)
      await provider.request({
        method: 'eth_sendTransaction',
        params: [{ from: address, to: tx.to, data: tx.data }],
      })
      toast.show(`Claiming ${row.ticker}`)
      // The balance zeroes once it confirms; re-reading is the only honest way to show that.
      setTimeout(() => void load(), 4000)
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'Could not claim')
    } finally {
      setClaiming(null)
    }
  }

  /**
   * Claims a single position's rewards, or withdraws it once the lock has expired.
   *
   * ⚠ `withdraw` claims as part of returning the principal, so it is never necessary to claim first
   * — and a position that has both is shown with both buttons only because claiming mid-lock is
   * allowed, not because withdrawing would leave rewards behind.
   */
  async function act(kind: 'claim' | 'withdraw', p: Position) {
    if (!provider || !address) return
    const key = `${p.poolId}:${p.id}`
    try {
      setWorking(key)
      const send = kind === 'claim' ? sendClaim : sendWithdraw
      await send({ poolId: p.poolId, positionId: p.id, from: address as Address }, provider)
      toast.show(kind === 'claim' ? 'Claiming rewards' : 'Unlocking your stake')
      // Same reasoning as the escrow rows: the position only changes once it confirms, and re-reading
      // is the only honest way to show that.
      setTimeout(() => void load(), 4000)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.show(
        /reject|denied/i.test(message)
          ? 'That was cancelled in your wallet, so nothing was signed.'
          : kind === 'claim'
            ? 'Could not claim'
            : 'Could not unlock',
      )
    } finally {
      setWorking(null)
    }
  }

  const hasRows = !!rows && rows.length > 0
  const hasStakes = positions.length > 0

  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Rewards</h1>
        <p>Every stock earned through staking claimable at any time.</p>
      </div>

      {hasStakes && (
        <section className="section" style={{ marginTop: 0 }}>
          <div className="section-head">
            <h2>Your stakes</h2>
            <p>Rewards can be claimed at any time. Principal returns when the lock expires.</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Staked</th>
                  <th className="right">Weight</th>
                  <th className="right">Unlocks</th>
                  <th className="right">Claimable</th>
                  <th className="right"></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <PositionRow
                    key={`${p.poolId}:${p.id}`}
                    position={p}
                    pool={pools.find((x) => x.id === p.poolId) ?? null}
                    assets={assets}
                    quotes={quotes}
                    busy={working === `${p.poolId}:${p.id}`}
                    onAct={act}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {hasRows && hasStakes && (
        <div className="section-head" style={{ marginBottom: 12 }}>
          <h2>Fees from tokens you launched</h2>
          <p>Creator fees Pons holds for this wallet, claimable per stock.</p>
        </div>
      )}

      {hasRows ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Stock</th>
                <th className="right">Claimable</th>
                <th className="right">Value</th>
                <th className="right"></th>
              </tr>
            </thead>
            <tbody>
              {rows!.map((r) => {
                const units = Number(r.amount) / 10 ** r.decimals
                const price = quotes[r.ticker]?.priceUsd
                return (
                  <tr key={r.ticker}>
                    <td>
                      <StockBadge ticker={r.ticker} to={false} />
                    </td>
                    <td className="right mono">{fmtAmount(units)}</td>
                    <td className="right mono">
                      {price != null ? usd(units * price) : <span className="muted">—</span>}
                    </td>
                    <td className="right">
                      <button
                        className="btn btn-primary"
                        disabled={claiming === r.ticker}
                        onClick={() => void claim(r)}
                      >
                        {claiming === r.ticker ? 'Claiming…' : 'Claim'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
        // Suppressed once stakes are listed: with a position on screen, "nothing to claim" would be
        // describing the escrow while reading as a statement about the whole page.
        !hasStakes && (
        <div className="card empty" style={{ padding: '56px 24px' }}>
          <div className="ico">
            <Mark size={30} />
          </div>
          <h3>{connected ? 'Nothing to claim' : 'Rewards'}</h3>
          <p style={{ maxWidth: 600 }}>
            {connected
              ? 'Your claimable stocks appear here, and can be claimed at any time.'
              : 'Connect your wallet to view your staking rewards and available claims.'}
          </p>
          {connected ? (
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
              <Link className="btn btn-primary" to="/stake">
                Stake <Arrow />
              </Link>
            </div>
          ) : (
            <button className="btn btn-primary btn-lg" onClick={openPicker}>
              <Wallet /> Connect Wallet
            </button>
          )}
        </div>
        )
      )}

      <section className="section">
        <Notice>Claimed rewards arrive as ordinary ERC-20 stocks in your own wallet.</Notice>
      </section>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * One open lock.
 *
 * ⚠ The multiplier shown is **derived from the position itself** (`weight / amount`), not looked up
 * from the current tier table. Tiers can be changed by the owner afterwards, and what pays this
 * position is the weight it was opened with — reading the table would show a number that is not the
 * one earning.
 */
function PositionRow({
  position,
  pool,
  assets,
  quotes,
  busy,
  onAct,
}: {
  position: Position
  pool: Pool | null
  assets: Record<string, AssetMeta>
  quotes: Record<string, Quote>
  busy: boolean
  onAct: (kind: 'claim' | 'withdraw', p: Position) => void
}) {
  const staked = pool ? assets[pool.stakeToken.toLowerCase()] : undefined
  const reward = pool ? assets[pool.rewardToken.toLowerCase()] : undefined

  const amountUnits = staked ? Number(position.amount) / 10 ** staked.decimals : null
  const pendingUnits = reward ? Number(position.pending) / 10 ** reward.decimals : null
  const rewardPrice = reward ? quotes[reward.symbol]?.priceUsd : undefined

  const multiplier = position.amount > 0n ? Number(position.weight) / Number(position.amount) : 0
  const unlocked = Date.now() >= position.unlockAt * 1000
  const unlockDate = new Date(position.unlockAt * 1000)

  return (
    <tr>
      <td>
        {amountUnits !== null ? (
          <b className="mono">
            {fmtAmount(amountUnits)} {staked!.symbol}
          </b>
        ) : (
          <span className="muted mono">{pool?.stakeToken ?? '—'}</span>
        )}
        <div className="tk-sub">
          {position.tierDays} {position.tierDays === 1 ? 'day' : 'days'} lock
        </div>
      </td>
      <td className="right mono">×{multiplier.toFixed(2)}</td>
      <td className="right">
        {unlocked ? (
          <b>Unlocked</b>
        ) : (
          <span className="mono">
            {unlockDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </span>
        )}
      </td>
      <td className="right mono">
        {pendingUnits !== null ? (
          <>
            {fmtAmount(pendingUnits)} {reward!.symbol}
            {rewardPrice != null && pendingUnits > 0 && (
              <div className="tk-sub">{usd(pendingUnits * rewardPrice)}</div>
            )}
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="right">
        <div style={{ display: 'inline-flex', gap: 8 }}>
          <button
            className="btn btn-ghost"
            disabled={busy || position.pending === 0n}
            onClick={() => onAct('claim', position)}
          >
            {busy ? '…' : 'Claim'}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !unlocked}
            onClick={() => onAct('withdraw', position)}
            // Locks cannot be exited early, so the button says why it is unavailable rather than
            // leaving a staker to guess that the site is broken.
            title={unlocked ? undefined : `Locked until ${unlockDate.toLocaleString()}`}
          >
            {unlocked ? 'Unstake' : 'Locked'}
          </button>
        </div>
      </td>
    </tr>
  )
}
