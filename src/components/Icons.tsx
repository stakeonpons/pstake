type P = { size?: number }

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const Wallet = ({ size = 17 }: P) => (
  <svg {...base(size)}>
    <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
    <path d="M16 12h.01" />
  </svg>
)

export const Lock = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <rect x="4" y="10" width="16" height="11" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
)

export const Chart = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M3 20h18" />
    <rect x="5" y="12" width="3.5" height="6" rx="1" />
    <rect x="10.5" y="8" width="3.5" height="10" rx="1" />
    <rect x="16" y="4" width="3.5" height="14" rx="1" />
  </svg>
)

export const Rocket = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M13.5 4.5C16 2 20 2.5 21 3.5s1.5 5-1 7.5l-4.5 4.5-6-6L13.5 4.5Z" />
    <path d="M9.5 9.5 5 11l2 2M14.5 14.5 13 19l-2-2" />
    <path d="M4 20l2-2" />
  </svg>
)

export const Search = ({ size = 17 }: P) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

export const Copy = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
)

export const Check = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="m4 12.5 5 5L20 6.5" />
  </svg>
)

export const External = ({ size = 15 }: P) => (
  <svg {...base(size)}>
    <path d="M14 4h6v6M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
)

export const Arrow = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <path d="M4 12h15M13 6l6 6-6 6" />
  </svg>
)

export const Gift = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <rect x="3" y="9" width="18" height="12" rx="2" />
    <path d="M3 13h18M12 9v12" />
    <path d="M12 9S9.5 3 7 4.5 9 9 12 9s5.5-3 3-4.5S12 9 12 9Z" />
  </svg>
)

export const Inbox = ({ size = 22 }: P) => (
  <svg {...base(size)}>
    <path d="M3 13h4l2 3h6l2-3h4" />
    <path d="M5 5h14l2 8v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l2-8Z" />
  </svg>
)

export const Info = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
)

export const Plus = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const Menu = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
)

export const Shield = ({ size = 18 }: P) => (
  <svg {...base(size)}>
    <path d="M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
)

export const Clock = ({ size = 16 }: P) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
)

/**
 * The mark: three stacked isometric layers — solid top, two chevrons below.
 *
 * Drawn with a filled top and stroked lower layers so the gaps between them are the page
 * background, which is what keeps it legible at favicon sizes and on either theme.
 */
/**
 * The pStake mark — the operator's actual logo file, not a redrawn approximation.
 *
 * Served from `/logo-64.png` rather than the 500px original so a 28px header slot is not
 * downscaling a 140 KB image; 64px covers 2× displays at the sizes this is used.
 *
 * The artwork sits in a 500×500 canvas with a symmetric 21px transparent margin (measured), so
 * it is already optically centred and needs no cropping or padding here.
 */
export const Mark = ({ size = 28 }: P) => (
  <img src="/logo-64.png" width={size} height={size} alt="" aria-hidden style={{ display: 'block' }} />
)

/**
 * The chain indicator.
 *
 * ⚠ Was BNB's four-diamond cube in Binance yellow. It takes its colour from `--accent` now rather
 * than a hard-coded hex, so it cannot drift away from the rest of the theme the way the old one
 * would have.
 */
export const ChainMark = ({ size = 15 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="var(--accent)">
    <circle cx="12" cy="12" r="9" opacity="0.18" />
    <path d="M7.5 14.6 L10.6 10.2 L13.4 12.9 L17 7.6" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
