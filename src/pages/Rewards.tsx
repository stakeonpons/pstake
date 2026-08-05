import { Link } from 'react-router-dom'
import { Arrow, Mark, Wallet } from '../components/Icons'
import { Notice } from '../components/Ui'
import { useWallet } from '../lib/wallet'

/**
 * Claimable rewards.
 *
 * Renders whatever is actually claimable — which, for a wallet with no position, is nothing. It
 * never invents a populated claim history, which is what used to be here.
 *
 * ⚠ Copy rule: nothing on this page describes the product as unbuilt or forthcoming. Write the
 * empty state as an empty state ("nothing to claim"), never as "not available yet".
 */
export default function Rewards() {
  const { connected, openPicker } = useWallet()

  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Rewards</h1>
        <p>Every bStock earned through staking claimable at any time.</p>
      </div>

      <div className="card empty" style={{ padding: '56px 24px' }}>
        <div className="ico">
          <Mark size={30} />
        </div>
        <h3>{connected ? 'Nothing to claim' : 'Rewards'}</h3>
        {/* Wider than the shared 400px `.empty p` cap so the sentence sits on one line; it is a
            max-width, so narrow viewports still wrap it instead of overflowing. */}
        <p style={{ maxWidth: 600 }}>
          {connected
            ? 'Your claimable bStocks appear here, and can be claimed at any time.'
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

      <section className="section">
        <Notice>
          Claimed rewards arrive as ordinary BEP-20 bStocks in your own wallet.
        </Notice>
      </section>
    </div>
  )
}
