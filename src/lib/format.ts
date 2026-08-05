export function usd(n: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact) return '$' + compact(n)
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function compact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  // Below a thousand, rounding to whole dollars turns a real figure into "$0". Keep enough places
  // that a small but genuine number still reads as one.
  if (abs >= 1) return n.toFixed(abs >= 100 ? 0 : 2)
  return abs === 0 ? '0' : trimZeros(n.toFixed(4))
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

/**
 * A token price, in plain decimal.
 *
 * Never exponent notation. A launch-priced token sits around 0.000003 and `toExponential` rendered
 * that as "$3.38e-6", which is unreadable at a glance and looks like a bug rather than a price.
 * Below a ten-thousandth the place count is derived from the magnitude so four significant digits
 * always survive, however small the number is.
 */
export function tokenPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  if (n >= 1) return '$' + trimZeros(n.toFixed(4))
  if (n >= 0.0001) return '$' + trimZeros(n.toFixed(6))
  const decimals = Math.min(18, Math.floor(-Math.log10(n)) + 4)
  return '$' + trimZeros(n.toFixed(decimals))
}

export function pct(n: number, digits = 2): string {
  return (n > 0 ? '+' : '') + n.toFixed(digits) + '%'
}

export function shares(n: number): string {
  return n.toFixed(4)
}

/**
 * A token balance.
 *
 * Precision scales with size because these are wallet balances, not display statistics: a meme
 * token balance of 250,000 wants no decimals, but XAUT is gold at ~$3.3k a unit and 6 decimals, so
 * flattening 1.5 to "2" overstates the holding and 0.4 to "0" erases it. The stake form's MAX
 * button fills the true value either way, so a rounded label also disagreed with the input.
 */
export function amount(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const digits = n >= 1000 ? 0 : n >= 1 ? 4 : 6
  return n.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}
