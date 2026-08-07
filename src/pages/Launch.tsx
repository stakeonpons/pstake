import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Address } from 'viem'
import { BRAND } from '../brand'
import { STOCKS, fetchQuotes, type Quote } from '../lib/stocks'
import {
  EMPTY_LINKS,
  readLaunchGate,
  sendLaunch,
  validateLaunch,
  type LaunchGate,
  type LaunchLinks,
} from '../lib/pons'
import { tokenFromReceipt } from '../lib/ponsIndexer'
import { recordLaunch } from '../lib/registry'
import { publicClient, explorerTx } from '../lib/chain'
import { useWallet } from '../lib/wallet'
import { useToast } from '../lib/toast'
import { StockBadge } from '../components/Ui'
import { Arrow, External, Rocket } from '../components/Icons'

/**
 * Launching a token through Stake.
 *
 * ## What changed from the flap build, and why the form is shorter
 *
 * Pons takes the token's **logo, description and socials as plain strings in the launch call**, so
 * there is no image upload, no IPFS pin and no metadata document. The old flow needed a pinning
 * proxy with a server-side key just to get an image on chain.
 *
 * There is also **no initial dev buy and no vanity salt**: `launchToken` takes params, a config id
 * and the pair token, and `msg.value` is the launch fee alone. flap needed an ERC-20 approval first
 * — the creator's buy was denominated in the quote asset — and a CREATE2 salt ground to an address
 * ending 7777. Neither exists here, so neither is asked for.
 *
 * ⚠⚠ **The gate is real, not decoration.** Pons controls `launchEnabled()` on the factory and it is
 * false today. This form reads it live on mount and again on submit: when Pons is closed, launching
 * is impossible and the page says so plainly rather than offering a button that produces a reverted
 * transaction and a lost gas fee.
 */
export default function Launch() {
  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Launch a token</h1>
        <p style={{ margin: '12px auto 0' }}>
          Deploy a staking-enabled {BRAND.launchpad} token paired with a stock.
        </p>
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <CreateForm />
      </div>
    </div>
  )
}

type Status =
  | { kind: 'idle' }
  | { kind: 'signing' }
  | { kind: 'confirming'; hash: string }
  | { kind: 'done'; hash: string; token: string }
  | { kind: 'error'; message: string }

/**
 * The square the logo is drawn into before it goes on chain.
 *
 * ⚠⚠ Pons stores the logo as a **plain string in the launch call**, so whatever the creator picks
 * is written to the chain verbatim and paid for as calldata, permanently. There is no pinning
 * service and no upload endpoint behind this page — see the header — so an uploaded file becomes a
 * `data:` URI rather than a link to somewhere that has to keep existing.
 *
 * ⚠ 128px is the whole reason this is affordable. A phone photo is hundreds of kilobytes; redrawn
 * to a 128px square and re-encoded it lands in single-digit kB. The exact size that will be written
 * is shown next to the field rather than left to be discovered on the gas estimate.
 */
const LOGO_PX = 128

async function fileToLogoDataUri(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement('canvas')
  canvas.width = LOGO_PX
  canvas.height = LOGO_PX
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d context')

  // Cover, not stretch: crop the long side so a rectangular source keeps its proportions.
  const side = Math.min(bitmap.width, bitmap.height)
  ctx.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    LOGO_PX,
    LOGO_PX,
  )
  bitmap.close?.()

  // WebP is markedly smaller than PNG at this size. A browser that cannot encode it returns PNG
  // from toDataURL rather than throwing, so this degrades to a larger string, never to a failure.
  return canvas.toDataURL('image/webp', 0.85)
}

function CreateForm() {
  const wallet = useWallet()
  const toast = useToast()
  const navigate = useNavigate()

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [logo, setLogo] = useState('')
  const [quoteAsset, setQuoteAsset] = useState('')
  const [links, setLinks] = useState<LaunchLinks>(EMPTY_LINKS)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [touched, setTouched] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [gate, setGate] = useState<LaunchGate | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)

  const logoIsUpload = logo.startsWith('data:')
  const logoKb = logoIsUpload ? (new Blob([logo]).size / 1024).toFixed(1) : null

  async function onPickLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    // Cleared so picking the SAME file again after a remove still fires a change event.
    e.target.value = ''
    if (!file) return
    setLogoError(null)
    try {
      setLogo(await fileToLogoDataUri(file))
    } catch {
      setLogoError('That image could not be read. Try a PNG, JPG or WebP.')
    }
  }

  useEffect(() => {
    void fetchQuotes().then(setQuotes).catch(() => {})
    // Read live on every mount. A cached "open" would offer a transaction the chain rejects.
    void readLaunchGate()
      .then(setGate)
      .catch(() => setGate({ enabled: false, feeWei: 0n }))
  }, [])

  const stock = useMemo(() => STOCKS.find((s) => s.ticker === quoteAsset), [quoteAsset])
  const error = useMemo(
    () => validateLaunch({ name, symbol, quoteTokenAddress: stock?.address ?? '' }),
    [name, symbol, stock],
  )

  const busy = status.kind === 'signing' || status.kind === 'confirming'
  const canSubmit = !!gate?.enabled && !error && !busy && !!wallet.address

  async function onSubmit() {
    setTouched(true)
    if (!wallet.address || !wallet.provider || !stock || error) return

    // Re-read rather than trusting what was fetched on mount: Pons can close launches between the
    // page loading and this click, and the failure mode is a reverted transaction whose gas the
    // creator has already paid for.
    const live = await readLaunchGate().catch(() => null)
    if (!live?.enabled) {
      setGate(live ?? { enabled: false, feeWei: 0n })
      setStatus({ kind: 'error', message: 'Pons is not accepting launches right now.' })
      return
    }

    try {
      setStatus({ kind: 'signing' })
      const hash = await sendLaunch(wallet.provider, {
        owner: wallet.address as Address,
        params: {
          name: name.trim(),
          symbol: symbol.trim(),
          description: description.trim(),
          logo: logo.trim(),
          quoteAsset: stock.ticker,
          quoteTokenAddress: stock.address,
          links,
        },
        launchFeeWei: live.feeWei,
      })

      setStatus({ kind: 'confirming', hash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      const token = tokenFromReceipt(receipt)
      if (!token) throw new Error('The launch confirmed but the token address could not be read.')

      // Records locally and submits to the shared registry, which re-verifies the fee route on
      // chain before listing. Never throws: a launch that confirmed must not look like a failure.
      await recordLaunch({ address: token, reward: stock.ticker, txHash: hash })

      setStatus({ kind: 'done', hash, token })
      toast.show(`${symbol.trim()} is live`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The launch could not be sent.'
      setStatus({ kind: 'error', message })
    }
  }

  if (status.kind === 'done') {
    return (
      <div className="card" style={{ textAlign: 'center', padding: 40 }}>
        <h2 style={{ marginTop: 0 }}>
          {symbol.trim()} is live on {BRAND.chain}
        </h2>
        <p className="muted">
          Paired with {stock?.ticker}. Its creator fees fund everyone staking {stock?.ticker}.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 22 }}>
          <button className="btn btn-primary" onClick={() => navigate(`/token/${status.token}`)}>
            View token <Arrow />
          </button>
          <a className="btn" href={explorerTx(status.hash)} target="_blank" rel="noreferrer">
            Transaction <External />
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="card launch-form" style={{ padding: 26 }}>
      {/*
        Pons's own switch, stated plainly. It is not a Stake setting and no amount of retrying
        changes it, so the honest thing is to name who controls it.
      */}
      {gate && !gate.enabled && (
        <div className="form-notice" style={{ marginBottom: 20 }}>
          Pons is not accepting launches right now. The factory's own <code>launchEnabled</code> flag
          is off; this page follows it, so launching works again the moment Pons opens it.
        </div>
      )}

      <div className="field">
        <div className="field-label">
          <span>Logo</span>
          <b>stored on chain</b>
        </div>
        <div className="logo-field">
          <label className="logo-pick">
            <input type="file" accept="image/*" onChange={onPickLogo} />
            <div className="image-drop">
              {logo.trim() !== '' ? <img src={logo} alt="" /> : <span>Upload image</span>}
            </div>
          </label>
          <div className="logo-side">
            {logoIsUpload ? (
              <>
                <div
                  className="text-input"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                >
                  <span>Uploaded image</span>
                  <button className="btn btn-ghost" onClick={() => setLogo('')}>
                    Remove
                  </button>
                </div>
                <div className="logo-hint">
                  {logoKb} kB, written on chain with the launch. Resized to {LOGO_PX}×{LOGO_PX}.
                </div>
              </>
            ) : (
              <>
                <input
                  className="text-input mono"
                  value={logo}
                  onChange={(e) => setLogo(e.target.value)}
                  placeholder="https://… or ipfs://…"
                />
                <div className="logo-hint">Upload an image, or paste a link to one.</div>
              </>
            )}
          </div>
        </div>
        {logoError && (
          <div className="form-error" style={{ marginTop: 10 }}>
            {logoError}
          </div>
        )}
      </div>

      <div className="grid grid-2" style={{ gap: 14 }}>
        <div className="field">
          <div className="field-label">
            <span>Name</span>
          </div>
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="MarsCoin"
            maxLength={32}
          />
        </div>
        <div className="field">
          <div className="field-label">
            <span>Symbol</span>
          </div>
          <input
            className="text-input"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="MARS"
            maxLength={16}
          />
        </div>
      </div>

      <div className="field">
        <div className="field-label">
          <span>Description</span>
        </div>
        <textarea
          className="textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this token about?"
          rows={3}
        />
      </div>

      <div className="field">
        <div className="field-label">
          <span>Paired stock</span>
          <b>what stakers are paid in</b>
        </div>
        <div className="stock-picker">
          {STOCKS.map((s) => (
            <button
              key={s.ticker}
              className={`stock-pick${quoteAsset === s.ticker ? ' active' : ''}`}
              onClick={() => setQuoteAsset(s.ticker)}
            >
              <StockBadge ticker={s.ticker} to={false} />
              <span className="muted mono">
                {quotes[s.ticker] ? `$${quotes[s.ticker].priceUsd.toFixed(2)}` : '—'}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-2" style={{ gap: 14 }}>
        {(
          [
            { key: 'twitter', label: 'X', placeholder: 'https://x.com/…' },
            { key: 'telegram', label: 'Telegram', placeholder: 'https://t.me/…' },
            { key: 'discord', label: 'Discord', placeholder: 'https://discord.gg/…' },
            { key: 'website', label: 'Website', placeholder: 'https://…' },
            { key: 'farcaster', label: 'Farcaster', placeholder: 'https://warpcast.com/…' },
          ] as const
        ).map((f) => (
          <div className="field" key={f.key}>
            <div className="field-label">
              <span>{f.label}</span>
              <b>optional</b>
            </div>
            <input
              className="text-input mono"
              value={links[f.key]}
              onChange={(e) => setLinks({ ...links, [f.key]: e.target.value })}
              placeholder={f.placeholder}
            />
          </div>
        ))}
      </div>

      {touched && error && <div className="form-error">{error}</div>}
      {status.kind === 'error' && <div className="form-error">{status.message}</div>}

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
        {wallet.address ? (
          <button className="btn btn-primary btn-lg" disabled={!canSubmit} onClick={onSubmit}>
            {status.kind === 'signing' ? (
              'Confirm in your wallet…'
            ) : status.kind === 'confirming' ? (
              'Launching…'
            ) : (
              <>
                Launch token <Rocket size={16} />
              </>
            )}
          </button>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={wallet.openPicker}>
            Connect wallet
          </button>
        )}
      </div>
    </div>
  )
}
