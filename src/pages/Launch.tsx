import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { parseEther, type Address } from 'viem'
import { BRAND } from '../brand'
import { STOCKS, fetchQuotes, type Quote } from '../lib/stocks'
import { EMPTY_LINKS, validateLaunch, type LaunchLinks } from '../lib/pons'
import {
  previewSnipe,
  readPoolFee,
  readV1Gate,
  sendSnipe,
  sendV1Launch,
  waitForTrading,
  type V1Gate,
} from '../lib/ponsV1'
import { LAUNCH_FEE_WALLET } from '../lib/launchPolicy'
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
 * ## ⚠⚠ Launches go through Pons **V1**, not V2
 *
 * V2 pairs against a tokenized stock, which is the shape this product describes, but Pons keeps
 * `launchEnabled = false` on it. V1 is open, so launches go there — and **V1 pairs against WETH,
 * always**. The stock picked below is therefore recorded by Stake, not enforced by the chain. See
 * the header of `ponsV1.ts`.
 *
 * ⭐ The **fee wallet is a launch parameter** on V1, so every token launched here routes its fees to
 * Stake in the launch call itself. It is policy, not a form value: never rendered, never editable.
 *
 * ⭐ The **developer buy is just extra `msg.value`** — proven by arithmetic on a real V1 launch
 * (tx value − launch fee == the recorded `initialBuyAmount`). One transaction, no approve, no
 * bonding curve, and denominated in **native ETH** rather than in the picked stock.
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
  const [gate, setGate] = useState<V1Gate | null>(null)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [devBuy, setDevBuy] = useState('')

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
    void readV1Gate()
      .then(setGate)
      .catch(() => setGate({ enabled: false, feeWei: 0n }))
  }, [])

  const stock = useMemo(() => STOCKS.find((s) => s.ticker === quoteAsset), [quoteAsset])
  const error = useMemo(
    () => validateLaunch({ name, symbol, quoteTokenAddress: stock?.address ?? '' }),
    [name, symbol, stock],
  )

  /*
    ⚠⚠ The V1 developer buy is denominated in **native ETH**, not in the stock. V1 pairs against
    WETH, so the buy rides along as extra `msg.value` on the launch call — see `buildV1Launch`.
    Parsing this with a stock's decimals would be wrong in both directions.
  */
  const devBuyWei = useMemo(() => {
    const v = devBuy.trim()
    if (!v) return 0n
    try {
      return parseEther(v)
    } catch {
      return null
    }
  }, [devBuy])

  const devBuyError = useMemo(() => {
    if (devBuy.trim() === '') return null
    if (devBuyWei === null) return 'Enter a number'
    if (devBuyWei <= 0n) return 'Enter an amount above zero'
    return null
  }, [devBuy, devBuyWei])

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
    const live = await readV1Gate().catch(() => null)
    if (!live?.enabled) {
      setGate(live ?? { enabled: false, feeWei: 0n })
      setStatus({ kind: 'error', message: 'Pons is not accepting launches right now.' })
      return
    }

    try {
      setStatus({ kind: 'signing' })
      const hash = await sendV1Launch(wallet.provider, {
        owner: wallet.address as Address,
        params: {
          name: name.trim(),
          symbol: symbol.trim(),
          description: description.trim(),
          logo: logo.trim(),
          links,
          // ⚠⚠ Policy, never a form value, and never rendered. This is what routes every token
          // launched here to Stake, and what makes it findable again through the locker's index.
          feeWallet: LAUNCH_FEE_WALLET,
        },
        // ⛔ No initial buy here, ever. V1 would credit the purchased tokens to `feeWallet`, which
        // is Stake — the creator would pay and we would receive. The buy is sniped below instead.
        launchFeeWei: live.feeWei,
      })

      setStatus({ kind: 'confirming', hash })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      const token = tokenFromReceipt(receipt)
      if (!token) throw new Error('The launch confirmed but the token address could not be read.')

      /*
        The stock the creator picked. ⚠⚠ V1 pairs against WETH, so this is NOT the on-chain pair —
        it is the routing instruction Stake stores, and the only place it is recorded. Written
        before navigating so the token is never listed without it.
      */
      await recordLaunch({ address: token, reward: stock.ticker, txHash: hash })

      /*
        The creator's buy, as a swap from THEIR wallet on the pool the launch just created.

        ⚠⚠ Deliberately not the launch's own initial buy: V1 sends those tokens to `feeWallet`, so
        on this site the creator would have spent the ETH and Stake would hold the tokens. Buying on
        the pool keeps the ETH and the tokens with the same wallet.

        ⚠ Never allowed to fail the launch. The token exists once the launch receipt lands, so a
        rejected or reverted snipe ends in `done` with a plain explanation, not an error screen.
      */
      let devBuyFailed: string | undefined
      if (devBuyWei && devBuyWei > 0n) {
        try {
          // ⚠⚠ Must come first. The token blocks transfers for `restrictionBlocks` after launch, so
          // both the simulation and the swap revert (Uniswap `TF`) until the window closes.
          const open = await waitForTrading(token as Address)
          if (!open) throw new Error('trading did not open in time for the buy')

          const poolFee = await readPoolFee(token as Address)
          const expected = await previewSnipe({
            owner: wallet.address as Address,
            token: token as Address,
            amountWei: devBuyWei,
            poolFee,
          })
          if (expected === null || expected === 0n) {
            throw new Error('the buy could not be simulated, so no slippage floor could be set')
          }
          const buyHash = await sendSnipe(wallet.provider, {
            owner: wallet.address as Address,
            token: token as Address,
            amountWei: devBuyWei,
            // 2% off the chain's own answer. Never zero: the launch and the buy are separate
            // transactions, so anyone can act in between.
            minOut: (expected * 9800n) / 10000n,
            poolFee,
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
              ETH
            </span>
          </div>
          <div className="logo-hint">
            {wallet.connected ? `You hold ${wallet.balanceNative.toFixed(4)} ETH.` : ''}
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
