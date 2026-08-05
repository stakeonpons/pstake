import { useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, type Address } from 'viem'
import { useNavigate } from 'react-router-dom'
import { BRAND } from '../brand'
import { STOCKS, fetchQuotes, stockByTicker, type Quote } from '../lib/stocks'
import {
  EMPTY_LINKS,
  QUOTE_ERC20_ABI,
  approveQuoteIfNeeded,
  findVanitySalt,
  sendLaunch,
  validateLaunch,
  type LaunchLinks,
} from '../lib/flap'
import { readBalances, tokenFromReceipt } from '../lib/flapIndexer'
import { recordLaunch } from '../lib/registry'
import { usd } from '../lib/format'
import { publicClient } from '../lib/chain'
import { hasMetadata, pinImage, pinTokenMetadata } from '../lib/ipfs'
import { useWallet } from '../lib/wallet'
import { Info, Rocket, Wallet } from '../components/Icons'

/**
 * The optional social links. The grid fills row by row, so this array order IS the on-screen
 * order: X and Website lead the first row, Telegram sits last. Keyed by `LaunchLinks` so a typo
 * here is a compile error rather than a silently dead field.
 */
const LINK_FIELDS: { key: keyof LaunchLinks; label: string; placeholder: string }[] = [
  { key: 'twitter', label: 'X', placeholder: 'https://x.com/…' },
  { key: 'website', label: 'Website', placeholder: 'https://…' },
  { key: 'github', label: 'GitHub', placeholder: 'https://github.com/…' },
  { key: 'youtube', label: 'YouTube', placeholder: 'https://youtube.com/…' },
  { key: 'debox', label: 'DeBox', placeholder: 'https://debox.pro/…' },
  { key: 'telegram', label: 'Telegram', placeholder: 'https://t.me/…' },
]

type Status =
  | { kind: 'idle' }
  | { kind: 'uploading' }
  | { kind: 'approving' }
  | { kind: 'pending' }
  | { kind: 'confirming' }
  | { kind: 'error'; message: string }

export default function Launch() {
  return (
    <div className="wrap page">
      <div className="page-head page-head-center">
        <h1>Launch a token</h1>
        <p style={{ margin: '12px auto 0' }}>
          Deploy a staking-enabled {BRAND.launchpad} token paired with a bStock.
        </p>
      </div>

      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <CreateForm />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Launch a new token                                                  */
/* ------------------------------------------------------------------ */

function CreateForm() {
  const { connected, openPicker, chainId, switchChain, provider, address } = useWallet()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [quoteAsset, setQuoteAsset] = useState('')
  const [devBuy, setDevBuy] = useState('')
  const [links, setLinks] = useState<LaunchLinks>(EMPTY_LINKS)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [touched, setTouched] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [quoteBalance, setQuoteBalance] = useState<number | null>(null)

  const stock = quoteAsset ? stockByTicker(quoteAsset) : undefined
  const quotePrice = quoteAsset ? (quotes[quoteAsset]?.priceUsd ?? null) : null

  useEffect(() => {
    void fetchQuotes().then(setQuotes).catch(() => {})
  }, [])

  // The creator's holding of the asset the token will actually be bought with. Re-read whenever
  // the pick changes, because each bStock is a different token with its own balance.
  useEffect(() => {
    setQuoteBalance(null)
    if (!address || !stock?.address) return
    let cancelled = false
    void readBalances(address as Address, [stock.address as Address])
      .then((b) => {
        if (cancelled) return
        const raw = b[stock.address!.toLowerCase()]
        setQuoteBalance(raw === undefined ? null : Number(raw) / 10 ** stock.decimals)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [address, stock])
  const quoteAssets = STOCKS
  const wrongChain = connected && chainId !== BRAND.chainId

  const errors = useMemo(
    () => validateLaunch({ name, symbol, quoteAsset, devBuy, quoteBalance }),
    [name, symbol, quoteAsset, devBuy, quoteBalance],
  )
  const valid = Object.keys(errors).length === 0
  const show = (k: string) => (touched ? errors[k] : undefined)

  const devBuyNum = Number(devBuy) || 0

  function pickImage(file: File | undefined) {
    if (!file) return
    setImageFile(file)
    setImageUrl(URL.createObjectURL(file))
  }

  async function onSubmit() {
    setTouched(true)
    if (!valid) return
    if (!provider || !address) return openPicker()
    if (!stock?.address) return
    try {
      // The on-chain `meta` field is one string: the CID of a document holding the artwork and the
      // links. Pinning runs BEFORE anything is signed, so if it fails the creator sees a plain
      // error with nothing spent — rather than a confirmed launch that silently lost their image.
      // A token with nothing to describe skips it entirely and launches with an empty meta.
      let meta = ''
      if (hasMetadata(imageFile, links, description)) {
        setStatus({ kind: 'uploading' })
        const imageCid = imageFile ? await pinImage(imageFile) : ''
        meta = await pinTokenMetadata({
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          description: description.trim(),
          imageCid,
          links,
        })
      }

      // ⚠ The buy is denominated in the quote asset, so it uses THAT token's decimals. XAUT is 6,
      // not 18 — parsing against a fixed 18 would ask for a million times the intended amount.
      const quoteAmt = parseUnits(devBuy.trim() || '0', stock.decimals)

      // The Portal pulls the quote asset with `transferFrom`, so the allowance has to exist before
      // the launch. Its own wallet prompt, and it must confirm before the launch is signed.
      if (quoteAmt > 0n) {
        setStatus({ kind: 'approving' })
        const approval = await approveQuoteIfNeeded(
          { quoteToken: stock.address as Address, amount: quoteAmt, owner: address as Address },
          {
            provider,
            readAllowance: (token, owner, spender) =>
              publicClient.readContract({
                address: token,
                abi: QUOTE_ERC20_ABI,
                functionName: 'allowance',
                args: [owner, spender],
              }),
          },
        )
        if (approval) await publicClient.waitForTransactionReceipt({ hash: approval })
      }

      setStatus({ kind: 'pending' })

      // The Portal requires the token address to end in 7777, so the salt is ground for it here
      // rather than guessed. Local hashing, well under a second.
      const { salt } = findVanitySalt(`${address}:${symbol}:${Date.now()}`)

      const hash = await sendLaunch(
        {
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          description: description.trim(),
          imageCid: meta,
          quoteAsset,
          quoteTokenAddress: stock.address,
          quoteAmt,
          salt,
          links,
        },
        { provider, from: address },
      )

      // Wait for the launch to actually confirm, then read the new token address straight out of
      // the Portal log in its own receipt. This is the one moment the site knows for certain that
      // a launch was its own, so it is where the token gets recorded.
      setStatus({ kind: 'confirming' })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      const token = tokenFromReceipt(receipt)
      if (!token) throw new Error('The launch confirmed but no token address was found in the receipt.')

      // Awaited: it writes the shared listing, and navigating first would land on a list that has
      // not been written yet.
      await recordLaunch({ address: token, reward: quoteAsset, txHash: hash })
      // Straight to the list, where it now appears.
      navigate('/tokens')
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  const busy =
    status.kind === 'pending' ||
    status.kind === 'uploading' ||
    status.kind === 'approving' ||
    status.kind === 'confirming'

  return (
    <div>
      {/* ------------------------------ form ------------------------------ */}
      <div className="card">
        <h2 style={{ fontSize: 19, marginBottom: 20, textAlign: 'center' }}>Token</h2>

        <div className="field">
          <div className="field-label">
            <span>Image</span>
            <b>PNG, JPG or WebP</b>
          </div>
          <button className="image-drop" onClick={() => fileRef.current?.click()}>
            {imageUrl ? (
              <img src={imageUrl} alt="" />
            ) : (
              <span className="image-drop-empty">
                <Rocket size={20} />
                <span>Choose an image</span>
              </span>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => pickImage(e.target.files?.[0])}
          />
        </div>

        <div className="grid grid-2" style={{ gap: 14 }}>
          <div className="field">
            <div className="field-label">
              <span>Name</span>
            </div>
            <div className="amount-input">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="MarsCoin"
                maxLength={32}
                style={{ fontSize: 15 }}
              />
            </div>
            {show('name') && <p className="field-error">{errors.name}</p>}
          </div>

          <div className="field">
            <div className="field-label">
              <span>Ticker</span>
            </div>
            <div className="amount-input">
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="MarsCoin"
                maxLength={10}
                style={{ fontSize: 15 }}
              />
            </div>
            {show('symbol') && <p className="field-error">{errors.symbol}</p>}
          </div>
        </div>

        <div className="field">
          <div className="field-label">
            <span>Description</span>
            <b>{description.length}/280</b>
          </div>
          <textarea
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 280))}
            placeholder="What is this token about?"
            rows={3}
          />
        </div>

        <h2 style={{ fontSize: 19, margin: '32px 0 20px', textAlign: 'center' }}>bStock</h2>

        <div className="field">
          <div className="field-label" style={{ justifyContent: 'center' }}>
            <span>Quote asset: the stock your stakers get paid in</span>
          </div>
          <div className="quote-grid">
            {quoteAssets.map((s) => (
              <button
                key={s.ticker}
                className={`quote-opt ${quoteAsset === s.ticker ? 'on' : ''}`}
                onClick={() => setQuoteAsset(s.ticker)}
              >
                <span className="mono qt">{s.ticker}</span>
                <span className="qc">{s.company}</span>
              </button>
            ))}
          </div>
          {show('quoteAsset') && <p className="field-error">{errors.quoteAsset}</p>}
        </div>

        <h2 style={{ fontSize: 19, margin: '32px 0 20px', textAlign: 'center' }}>Optional links</h2>

        <div className="link-grid">
          {LINK_FIELDS.map((f) => (
            <div className="field" key={f.key}>
              <div className="field-label">
                <span>{f.label}</span>
              </div>
              <div className="amount-input">
                <input
                  value={links[f.key]}
                  onChange={(e) => setLinks((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  inputMode="url"
                  style={{ fontSize: 15 }}
                />
              </div>
            </div>
          ))}
        </div>

        <h2 style={{ fontSize: 19, margin: '32px 0 20px', textAlign: 'center' }}>
          Creator Token Purchase (Optional)
        </h2>

        <div className="field">
          <div className="field-label">
            <span>Your initial buy (optional)</span>
            {/* Balance only appears once a stock is picked: until then there is no asset to state a
                balance in, and showing BNB would be wrong — the buy is made in the quote asset. */}
            {quoteAsset && (
              <b className="mono">
                {quoteBalance === null ? '…' : `Balance: ${quoteBalance.toLocaleString('en-US', {
                  maximumFractionDigits: 6,
                })} ${quoteAsset}`}
              </b>
            )}
          </div>

          {quoteAsset ? (
            <>
              <div className="amount-input">
                <input
                  inputMode="decimal"
                  value={devBuy}
                  onChange={(e) => setDevBuy(e.target.value.replace(/[^0-9.]/g, ''))}
                  placeholder="0.0"
                />
                {quoteBalance !== null && quoteBalance > 0 && (
                  <button className="max-btn" onClick={() => setDevBuy(String(quoteBalance))}>
                    MAX
                  </button>
                )}
                <span className="unit">{quoteAsset}</span>
              </div>

              <div className="buy-value">
                <span>You will buy with</span>
                <b className="mono">
                  {devBuyNum > 0 && quotePrice !== null
                    ? usd(devBuyNum * quotePrice)
                    : devBuyNum > 0
                      ? '—'
                      : usd(0)}
                </b>
              </div>
              {quotePrice !== null && (
                <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                  1 {quoteAsset} = {usd(quotePrice)}
                </p>
              )}
            </>
          ) : (
            <p className="muted center" style={{ fontSize: 13.5 }}>
              Pick a bStock above first. Your token is bought with that stock, so the first buy is
              made in it rather than in BNB.
            </p>
          )}
          {show('devBuy') && <p className="field-error">{errors.devBuy}</p>}
        </div>

        {/* ------------------------------ submit ------------------------------ */}
        {!connected ? (
          <button className="btn btn-primary btn-lg btn-block" onClick={openPicker}>
            <Wallet /> Connect Wallet
          </button>
        ) : wrongChain ? (
          <button className="btn btn-primary btn-lg btn-block" onClick={switchChain}>
            Switch to {BRAND.chain}
          </button>
        ) : (
          <button className="btn btn-primary btn-lg btn-block" onClick={onSubmit} disabled={busy}>
            <Rocket size={17} />
            {status.kind === 'uploading'
              ? 'Pinning image…'
              : status.kind === 'approving'
                ? `Approve ${quoteAsset} in your wallet…`
              : status.kind === 'pending'
                ? 'Confirm in your wallet…'
                : status.kind === 'confirming'
                  ? 'Launching…'
                : `Launch ${symbol ? '$' + symbol : 'token'}`}
          </button>
        )}

        {status.kind === 'error' && (
          <div className="alert alert-error">
            <Info />
            <div>
              <b>Launch failed</b>
              <p>{status.message}</p>
            </div>
          </div>
        )}

      </div>

      {/* Three short columns rather than a bullet list: the card is 980px wide, and a left-aligned
          list under a centred heading leaves the right half empty. Mirrors "How it works" on Home. */}
      <div style={{ marginTop: 34 }}>
        <div className="section-head section-head-center">
          <h2 style={{ fontSize: 24 }}>What launching here changes</h2>
        </div>
        <div className="grid grid-3">
          <div className="step step-plain">
            <p>
              The fee beneficiary is set inside the launch transaction so there is nothing to
              configure afterwards.
            </p>
          </div>
          <div className="step step-plain">
            <p>The quote asset is enforced as a bStock, so rewards are real equity from day one.</p>
          </div>
          <div className="step step-plain">
            <p>Your pool opens the moment the token exists.</p>
          </div>
        </div>
        <p className="muted center" style={{ fontSize: 13, marginTop: 16 }}>
          {BRAND.name} never takes custody of your token.
        </p>
      </div>
    </div>
  )
}
