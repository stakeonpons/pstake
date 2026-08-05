import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Check, Copy, Info, Mark, Plus } from './Icons'
import { pct } from '../lib/format'
import { BRAND } from '../brand'

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value mono">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  )
}

export function Change({ value, digits = 2 }: { value: number; digits?: number }) {
  return <span className={`mono ${value >= 0 ? 'up' : 'down'}`}>{pct(value, digits)}</span>
}

export function StockBadge({ ticker, to = true }: { ticker: string; to?: boolean }) {
  const el = <span className="badge badge-stock">{ticker}</span>
  return to ? <Link to={`/pstocks?q=${ticker}`}>{el}</Link> : el
}

export function CopyRow({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="copy-row">
      <code>{text}</code>
      <button
        className="btn btn-ghost"
        onClick={() => {
          navigator.clipboard?.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        }}
      >
        {done ? <Check /> : <Copy />}
        {done ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/**
 * The contract-address pill in the hero. One click copies the whole address.
 *
 * Renders a "published at launch" state while `BRAND.tokenCa` is empty rather than a placeholder
 * or zero address — a wrong-looking CA in a hero is indistinguishable from a scam clone, and
 * someone would eventually copy it.
 */
export function CaPill() {
  const [copied, setCopied] = useState(false)
  const ca = BRAND.tokenCa

  if (!ca) {
    return (
      <span className="eyebrow ca-pill ca-pill-pending">CA: TBA</span>
    )
  }

  return (
    <button
      className="eyebrow ca-pill"
      title="Click to copy the contract address"
      onClick={() => {
        navigator.clipboard?.writeText(ca)
        setCopied(true)
        setTimeout(() => setCopied(false), 1600)
      }}
    >
      <span className="ca-label">CA:</span>
      <span className="mono ca-value">{ca}</span>
      <span className="ca-icon">{copied ? <Check size={14} /> : <Copy size={14} />}</span>
      {copied && <span className="ca-copied">Copied</span>}
    </button>
  )
}

export function Empty({
  title,
  body,
  action,
  icon,
}: {
  title: string
  body: string
  action?: ReactNode
  /** Defaults to the brand mark; pass something else where a page warrants it. */
  icon?: ReactNode
}) {
  return (
    <div className="card empty">
      <div className="ico">{icon ?? <Mark size={30} />}</div>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  )
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <Info />
      <div>{children}</div>
    </div>
  )
}

export function Sparkline({
  data,
  color,
  width = 96,
  height = 30,
  fluid = false,
}: {
  data: number[]
  color: string
  width?: number
  height?: number
  /** Stretch to the container width. Stroke stays 1.6px via non-scaling-stroke. */
  fluid?: boolean
}) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const span = max - min || 1
  const step = width / (data.length - 1)
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`)
  const id = `sg-${color.replace('#', '')}-${data.length}-${fluid ? 'f' : 's'}`
  return (
    <svg
      className="spark"
      width={fluid ? '100%' : width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio={fluid ? 'none' : undefined}
      aria-hidden
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${pts.join(' ')} ${width},${height}`} fill={`url(#${id})`} />
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        vectorEffect={fluid ? 'non-scaling-stroke' : undefined}
      />
    </svg>
  )
}

export function Faq({ items }: { items: { q: string; a: ReactNode }[] }) {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <div className="card" style={{ padding: '4px 24px' }}>
      {items.map((it, i) => (
        <div className="faq-item" key={it.q}>
          <button className="faq-q" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
            {it.q}
            <span className="pm">
              <Plus />
            </span>
          </button>
          {open === i && <div className="faq-a">{it.a}</div>}
        </div>
      ))}
    </div>
  )
}
