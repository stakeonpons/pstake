import { useEffect, useState } from 'react'
import Modal from './Modal'
import { useWallet } from '../lib/wallet'
import {
  INSTALL_LINKS,
  legacyProvider,
  subscribe,
  type ProviderDetail,
} from '../lib/eip6963'
import { BRAND } from '../brand'
import { External } from './Icons'

export default function WalletModal() {
  const { pickerOpen, closePicker, connectTo, connecting, error } = useWallet()
  const [providers, setProviders] = useState<ProviderDetail[]>([])
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => subscribe(setProviders), [])

  // Only fall back to the legacy global when nothing announced itself, so a modern wallet is
  // never shadowed by whichever extension grabbed window.ethereum last.
  const legacy = providers.length === 0 ? legacyProvider() : null
  const list = providers.length ? providers : legacy ? [legacy] : []

  return (
    <Modal
      open={pickerOpen}
      onClose={closePicker}
      title="Connect a wallet"
      subtitle={`Stake runs on ${BRAND.chain}. Choose a wallet to continue.`}
    >
      {list.length > 0 ? (
        <div className="wallet-list">
          {list.map((d) => (
            <button
              key={d.info.uuid}
              className="wallet-opt"
              disabled={connecting}
              onClick={() => {
                setPending(d.info.uuid)
                void connectTo(d)
              }}
            >
              {d.info.icon ? (
                <img src={d.info.icon} alt="" className="wallet-icon" />
              ) : (
                <span className="wallet-icon wallet-icon-fallback">{d.info.name.slice(0, 1)}</span>
              )}
              <span className="wallet-name">{d.info.name}</span>
              <span className="wallet-state">
                {connecting && pending === d.info.uuid ? 'Check your wallet…' : 'Detected'}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="wallet-empty">
          <p>
            No wallet extension detected in this browser. Install one, then reload this page. It
            will appear here automatically.
          </p>
          <div className="wallet-install">
            {INSTALL_LINKS.map((w) => (
              <a key={w.name} className="btn btn-ghost" href={w.url} target="_blank" rel="noreferrer">
                {w.name} <External size={13} />
              </a>
            ))}
          </div>
        </div>
      )}

      {error && <div className="alert alert-error" style={{ marginTop: 14 }}>{error}</div>}

      <p className="muted" style={{ fontSize: 12.5, marginTop: 18, lineHeight: 1.6 }}>
        Stake never asks for a seed phrase or private key, and cannot move your funds without a
        transaction you approve yourself.
      </p>
    </Modal>
  )
}
