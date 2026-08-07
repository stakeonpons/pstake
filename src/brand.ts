/**
 * Every piece of naming lives here. Rename the product in one place.
 */
export const BRAND = {
  /** The name in prose: sentences, the tab title, the footer, link previews. */
  name: 'Stake',
  /**
   * The wordmark for the logo lockup in the header and footer only.
   *
   * ⚠ Kept as a separate field from `name` even though the two now match: the lockup and prose are
   * styled independently, so changing one must not silently change the other.
   * ✏️ Capitalised 7 Aug at the operator's request, reversing the earlier lowercase mark.
   */
  wordmark: 'Stake',
  tagline: 'Stake your bag. Earn real stocks.',
  domain: 'stakeonpons.xyz',
  twitter: 'https://x.com/stakeonpons',
  /** The public repository. Cleared, the footer renders the entry as plain text instead. */
  github: 'https://github.com/stakeonpons/pstake',
  chain: 'Robinhood Chain',
  chainId: 4663,
  /**
   * The chain's own page, for the footer link.
   *
   * ⚠ This link was still pointing at bnbchain.org after the migration, under the label "Robinhood
   * Chain" — a live link sending visitors to the wrong chain entirely. Verified to answer 200
   * before being put here.
   */
  chainUrl: 'https://robinhood.com/chain',
  /** Blockscout, the chain's explorer. */
  explorerUrl: 'https://robinhoodchain.blockscout.com',
  launchpad: 'Pons',
  launchpadUrl: 'https://www.ponsfamily.com/launchpad',
  /**
   * The Stake token contract address, shown as the copyable CA pill on the home page.
   *
   * Empty until the token exists — the pill reads "TBA" rather than showing a fake or zero
   * address, because a zero address in a CA slot is exactly what a scam clone looks like.
   *
   * ➤ Setting this one string switches on BOTH the home page CA pill AND the token's pinned card
   * on /tokens. Nothing else needs changing.
   */
  tokenCa: '',

  /**
   * The Stake token's own listing on /tokens.
   *
   * It is the first token launched on this platform, so it is **pinned to the front of the grid and
   * shown regardless of any search or filter** — a visitor should never have to hunt for it, and a
   * reward filter should never hide it. Its card is outlined so it reads as ours at a glance.
   *
   * ➤ **To switch it on: set `tokenCa` above to the contract address. Nothing else.** The card then
   * reads its name, symbol, price, liquidity, market cap, 24h change and volume live from chain and
   * DexScreener exactly like every other token, and `pinned.ts` supplies the artwork and identity
   * below so the card is right from the first block.
   */
  pinned: {
    name: 'Stake',
    /**
     * ⚠ This OVERRIDES the on-chain symbol on the card and the token page (`registry.ts`,
     * `TokenDetail.tsx`), so it has to match what was actually launched or the site contradicts the
     * chain. The token is **STAKE**; this said `Stake` until 7 Aug.
     */
    symbol: 'STAKE',
    /** Shipped artwork, not read from token metadata — this is the brand mark. */
    image: '/pstake-token.png',
  },

  /**
   * ⛔ There is deliberately no `feeWallet` here.
   *
   * There used to be, holding the zero address, and `/docs` printed it under "set your creator-fee
   * recipient to:" with a copy button — an instruction that would have burned a creator's fee
   * stream permanently. It is gone rather than corrected because the real destination must not be
   * a display value at all: it lives in `LAUNCH_POLICY.feeRecipient` (`lib/pons.ts`), is applied
   * inside the launch transaction, and is never rendered.
   *
   * Do not reintroduce a fee address in this file, and do not print one anywhere in the UI.
   */

  /** Protocol cut of claimed creator fees, in basis points. */
  protocolFeeBps: 200,

  /**
   * Optional. Only relevant if Stake ever deploys tokens from its OWN wallet on a creator's
   * behalf — a custodial model this app does not use.
   *
   * The launch flow sends the transaction from **the creator's own wallet**, so the deployer in a
   * launch event is a different address every time and cannot identify "launched here". What
   * identifies a Stake token is its **fee beneficiary** — see `isOurs()` in `registry.ts`.
   */
  launcherWallets: [] as readonly string[],

  /**
   * Addresses allowed to add and remove tokens manually.
   *
   * Read from `VITE_ADMIN_WALLETS` (comma separated) so it is not committed to a public
   * repository. It still ships inside the JS bundle — unavoidable for a client-side gate, and
   * harmless in itself since addresses are public.
   *
   * ⚠ See `admin.ts`: this is a UI gate, not access control. The registry's `DELETE` verifies a
   * signature server side, which is where the real check lives.
   */
  adminWallets: ((import.meta.env.VITE_ADMIN_WALLETS as string | undefined) ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean) as readonly string[],
} as const

/** Lock tiers. Longer lock ⇒ larger share of the same fee pot. */
export const LOCK_TIERS = [
  { days: 1, multiplier: 1.0 },
  { days: 3, multiplier: 1.25 },
  { days: 7, multiplier: 1.5 },
  { days: 14, multiplier: 2.0 },
  { days: 21, multiplier: 2.5 },
  { days: 30, multiplier: 3.0 },
] as const

export type LockTier = (typeof LOCK_TIERS)[number]
