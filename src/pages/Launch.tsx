import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatUnits, parseUnits, type Address } from 'viem'
import { BRAND } from '../brand'
import { STOCKS, fetchQuotes, type Quote } from '../lib/stocks'
import {
  EMPTY_LINKS,
  ERC20_APPROVE_ABI,
  applySlippage,
  previewDevBuy,
  readCurveFor,
  readLaunchGate,
  sendApprove,
  sendDevBuy,
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
 * ## What changed from the flap build
 *
 * Pons takes the token's **logo, description and socials as plain strings in the launch call**, so
 * there is no IPFS pin and no metadata document. The old flow needed a pinning proxy with a
 * server-side key just to get an image on chain.
 *
 * ⭐ The logo is **uploaded, not linked** — there is no upload endpoint anywhere in this project, so
 * the picked file is redrawn to a small square and encoded as a `data:` URI that travels in the
 * launch call itself. See `fileToLogoDataUri`.
 *
 * ⚠⚠ **The dev buy is NOT part of the launch, and no amount of looking will find a parameter for
 * it.** `launchToken` takes params, a config id and the pair token, and `msg.value` is the launch
 * fee alone; the verified factory ABI has no buy field and no buy function, and all 16 real V2
 * launches report `initialBuyWei: 0`. A creator's first buy is therefore a separate **approve +
 * `buy` against the bonding curve** once the launch has confirmed — see `CURVE_ABI` in `pons.ts`.
 *
 * There is still **no vanity salt**: flap ground a CREATE2 salt to an address ending 7777, which
 * has no equivalent here.
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
  | { kind: 'approving'; hash: string }
  | { kind: 'buying'; hash: string }
  | { kind: 'done'; hash: string; token: string; devBuyFailed?: string }
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
  const [devBuy, setDevBuy] = useState('')
  const [pairBalance, setPairBalance] = useState<{ raw: bigint; decimals: number } | null>(null)

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

  /*
    The creator's balance of the stock they picked, so the dev buy can be checked against something
    real instead of failing at signing time. Re-read whenever the pair or the wallet changes.
  */
  useEffect(() => {
    setPairBalance(null)
    if (!stock?.address || !wallet.address) return
    let cancelled = false
    void publicClient
      .readContract({
        address: stock.address as Address,
        abi: ERC20_APPROVE_ABI,
        functionName: 'balanceOf',
        args: [wallet.address as Address],
      })
      .then((raw) => {
        if (!cancelled) setPairBalance({ raw: raw as bigint, decimals: stock.decimals })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [stock?.address, stock?.decimals, wallet.address])

  /*
    ⚠⚠ Parsed with the PAIR TOKEN's own decimals, never a flat 1e18. USDG is 6, so a flat parse
    would ask for a trillion times the intended amount and the approve would silently cover it.
    ⚠ parseUnits throws on a half-typed number ("0.", "1e"), which is an ordinary keystroke here.
  */
  const devBuyWei = useMemo(() => {
    const t = devBuy.trim()
    if (!t || !stock) return 0n
    try {
      return parseUnits(t, stock.decimals)
    } catch {
      return null
    }
  }, [devBuy, stock])

  const devBuyError = useMemo(() => {
    if (devBuy.trim() === '') return null
    if (devBuyWei === null) return 'Enter a number'
    if (devBuyWei <= 0n) return 'Enter an amount above zero'
    if (pairBalance && devBuyWei > pairBalance.raw) return `More ${stock?.ticker} than you hold`
    return null
  }, [devBuy, devBuyWei, pairBalance, stock])
  const error = useMemo(
    () => validateLaunch({ name, symbol, quoteTokenAddress: stock?.address ?? '' }),
    [name, symbol, stock],
  )

  const busy =
    status.kind === 'signing' ||
    status.kind === 'confirming' ||
    status.kind === 'approving' ||
    status.kind === 'buying'
  // ⚠ `devBuyError` gates submission too: the dev buy spends real money, so a bad amount must stop
  // the launch rather than be discovered between two signatures.
  const canSubmit = !!gate?.enabled && !error && !devBuyError && !busy && !!wallet.address

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

      /*
        The developer buy, if asked for.

        ⚠⚠ This runs AFTER the launch has already confirmed, and it is deliberately not allowed to
        turn a successful launch into a failed one. The token exists on chain from the moment the
        launch receipt lands; if the approve or the buy then fails or is rejected, the creator still
        has their token and is told the buy did not happen, rather than seeing an error screen that
        implies the launch itself broke. Every path below therefore ends in `done`.
      */
      let devBuyFailed: string | undefined
      if (devBuyWei && devBuyWei > 0n) {
        try {
          const curve = await readCurveFor(token as Address)
          if (!curve) throw new Error('the curve address could not be read')

          const approveHash = await sendApprove(wallet.provider, {
            owner: wallet.address as Address,
            pairToken: stock.address as Address,
            curve,
            amount: devBuyWei,
          })
          setStatus({ kind: 'approving', hash: approveHash })
          await publicClient.waitForTransactionReceipt({ hash: approveHash })

          // Simulated only now, because the curve pulls the quote during the call and a preview
          // before the allowance exists reverts for reasons unrelated to price.
          const expected = await previewDevBuy({
            owner: wallet.address as Address,
            curve,
            quoteIn: devBuyWei,
          })
          if (expected === null || expected === 0n) {
            throw new Error('the buy could not be simulated, so no slippage floor could be set')
          }

          const buyHash = await sendDevBuy(wallet.provider, {
            owner: wallet.address as Address,
            curve,
            quoteIn: devBuyWei,
            minTokensOut: applySlippage(expected),
          })
          setStatus({ kind: 'buying', hash: buyHash })
          await publicClient.waitForTransactionReceipt({ hash: buyHash })
        } catch (err) {
          devBuyFailed = err instanceof Error ? err.message : 'the buy could not be sent'
        }
      }

      setStatus({ kind: 'done', hash, token, devBuyFailed })
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
        {/* The launch succeeded; only the follow-up buy did not. Said plainly so it is not mistaken
            for a failed launch, and so the creator knows to buy manually if they still want to. */}
        {status.devBuyFailed && (
          <div className="form-error" style={{ marginTop: 18, textAlign: 'left' }}>
            Your token launched, but the developer buy did not go through: {status.devBuyFailed}. You
            still hold your {stock?.ticker}, and you can buy on the token's page.
          </div>
        )}
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
        ⚠ The gate is still READ and still gates submission — `canSubmit` requires `gate.enabled`,
        and `onSubmit` re-reads it live before signing so a launch is never offered against a closed
        factory. Only the banner that announced the closure was removed, at the operator's request.
        Do not restore it as a "fix" for the button being disabled.
      */}
      {/*
        ⚠ Upload only — there is deliberately no URL field. `logo` therefore only ever holds a
        `data:` URI produced by `fileToLogoDataUri`, which `logoIsUpload` still checks rather than
        assumes, so a value arriving any other way cannot render as though it were uploaded.
      */}
      <div className="field">
        <div className="field-label">
          <span>Logo</span>
        </div>
        <div className="logo-field">
          <label className="logo-pick">
            <input type="file" accept="image/*" onChange={onPickLogo} />
            <div className="image-drop">
              {logoIsUpload ? <img src={logo} alt="" /> : <span>Upload image</span>}
            </div>
          </label>
          <div className="logo-side">
            {logoIsUpload && (
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
            placeholder="StakeCoin"
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
            placeholder="STAKE"
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

      {/*
        ⚠⚠ NOT part of the launch transaction. Pons V2's `launchToken` has no buy amount — see the
        header on `CURVE_ABI`. This is a separate approve + buy against the bonding curve once the
        launch has confirmed, which is why it is priced in the paired stock and needs a balance of
        it. Shown only once a stock is chosen, because the amount is meaningless before then.
      */}
      {stock && (
        <div className="field">
          <div className="field-label">
            <span>Developer buy</span>
            <b>optional</b>
          </div>
          <div className="amount-input">
            <input
              value={devBuy}
              onChange={(e) => setDevBuy(e.target.value)}
              placeholder="0.0"
              inputMode="decimal"
            />
            <span className="muted mono" style={{ padding: '0 12px' }}>
              {stock.ticker}
            </span>
          </div>
          <div className="logo-hint">
            {pairBalance
              ? `You hold ${formatUnits(pairBalance.raw, pairBalance.decimals)} ${stock.ticker}. `
              : ''}
            Bought on the curve straight after the launch, in two more transactions.
          </div>
          {touched && devBuyError && (
            <div className="form-error" style={{ marginTop: 10 }}>
              {devBuyError}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-2" style={{ gap: 14 }}>
        {(
          [
            { key: 'twitter', label: 'X', placeholder: 'https://x.com/…' },
            { key: 'telegram', label: 'Telegram', placeholder: 'https://t.me/…' },
            { key: 'discord', label: 'Discord', placeholder: 'https://discord.gg/…' },
            { key: 'website', label: 'Website', placeholder: 'https://…' },
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
            ) : status.kind === 'approving' ? (
              `Approving ${stock?.ticker ?? ''}…`
            ) : status.kind === 'buying' ? (
              'Buying…'
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
