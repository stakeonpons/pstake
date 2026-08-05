import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Address } from 'viem'
import { Arrow, Mark, Wallet } from '../components/Icons'
import { Notice, StockBadge } from '../components/Ui'
import { useWallet } from '../lib/wallet'
import { useToast } from '../lib/toast'
import { buildClaim, readClaimable, type ClaimableRow } from '../lib/fees'
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

  const load = useCallback(async () => {
    if (!address) {
      setRows(null)
      return
    }
    const [claimable, q] = await Promise.all([
      readClaimable(address as Address).catch(() => null),
      fetchQuotes().catch(() => ({}) as Record<string, Quote>),
    ])
    setQuotes(q)
    // Only rows with something in them. A table of zeroes is noise, not information.
    setRows(claimable ? claimable.rows.filter((r) => r.amount > 0n) : [])
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

  const hasRows = !!rows && rows.length > 0

  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Rewards</h1>
        <p>Every stock earned through staking claimable at any time.</p>
      </div>

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
      )}

      <section className="section">
        <Notice>Claimed rewards arrive as ordinary ERC-20 stocks in your own wallet.</Notice>
      </section>
    </div>
  )
}
