/**
 * The token registry behind /tokens.
 *
 * ## What makes a token "ours"
 *
 * Creators launch from **their own wallet** — Stake builds the transaction, their wallet signs and
 * pays for it. So the `deployer` in a Pons launch event is a different address every time and says
 * nothing about whether the launch came through this site. Filtering on it cannot work.
 *
 * The durable answer is the **fee beneficiary**, which is nominated inside the launch transaction.
 * A token whose beneficiary is `LAUNCH_POLICY.creatorFeeRecipient` pays its creator fees to Stake's
 * stakers, and that is precisely what qualifies it — whether it was launched here, or launched on
 * Pons and pointed here afterwards. Ownership of the click is irrelevant; the fee route is the
 * product.
 *
 * ✅ `isOurs()` reads that beneficiary on chain — the Pons factory records it as
 * `creatorFeeRecipient` on the launch — so membership is verifiable rather than asserted. What is
 * harder here is DISCOVERY: knowing an address is ours is one call, enumerating every token that
 * points at us means walking every Pons launch, and ⚠ this chain's 2,000-block `getLogs` cap puts
 * that beyond a browser entirely. So the list comes from:
 *
 *  1. **The shared registry** — the source of truth, served to every visitor. A token reaches it
 *     either by being submitted when its launch confirms, or by being found by the discovery scan;
 *     both are verified against the chain before listing.
 *  2. **Recorded launches and manual additions** — kept in `localStorage` as a fallback, so
 *     somebody who has just launched a token still sees it if the registry is briefly unreachable.
 *
 * ⚠ Local entries are visible only in the browser that created them, which is why they are a
 * fallback and not the source of truth.
 */

import { getAddress, isAddress, type Address } from 'viem'
import { BRAND } from '../brand'
import { readToken, readTokenArt, type OnChainToken } from './ponsIndexer'
import { PREVIEW_PINNED_STANDIN, PREVIEW_TOKENS, previewOn } from './preview'
import { pinnedAddress } from './pinned'
import { fetchMarketExtras } from './market'
import { fetchListed, submitToken } from './registryApi'
import { isOurs } from './fees'
import { listV1TokensFor } from './ponsV1'
import { LAUNCH_FEE_WALLET } from './launchPolicy'


import type { Quote } from './stocks'

/**
 * Artwork and description for a token.
 *
 * Defined here rather than in its own module now that it is a plain contract read — there is no
 * IPFS document, no gateway fallback and no launch-event recovery left to justify one.
 */
export type TokenMeta = {
  imageUrl: string | null
  description: string | null
  twitter: string | null
  telegram: string | null
  website: string | null
}


export const MANUAL_STORAGE_NOTE =
  'Kept in this browser as a fallback. The shared registry is what other visitors see.'

const KEY = 'pstake.manual-tokens.v1'
const LAUNCHED_KEY = 'pstake.launched-here.v1'

/**
 * Whether a token's creator fees are routed to Stake — the real membership test.
 *
 * Implemented in `fees.ts` and re-exported here so callers are unchanged: it reads
 * `creatorFeeRecipient` off the Pons launch record and compares it with
 * `LAUNCH_POLICY.creatorFeeRecipient`.
 *
 * Stronger than a list: it holds for a token launched here and for one launched on Pons directly
 * that points its fees here, and it cannot be faked by writing to `localStorage`.
 *
 * ⚠⚠ **Read live, never cached.** This can be changed after launch — the factory has
 * `executeCreatorFeeRecipientChange` behind a timelock — so a stored "yes" would eventually be a
 * claim the chain no longer supports. Null still means "cannot determine", never "no".
 */
export { isOurs }

export type LaunchRecord = {
  address: Address
  reward: string
  txHash: string
  at: number
}

export function loadLaunched(): LaunchRecord[] {
  try {
    const raw = localStorage.getItem(LAUNCHED_KEY)
    const parsed = raw ? (JSON.parse(raw) as LaunchRecord[]) : []
    return Array.isArray(parsed) ? parsed.filter((r) => isAddress(r.address)) : []
  } catch {
    return []
  }
}

/**
 * Records a token launched through Stake, the moment its transaction confirms.
 *
 * Writes to **both** places, on purpose:
 *  - the shared registry, so every visitor sees the token. The server re-verifies the fee route
 *    against the chain, so this is a submission, not an assertion — and it needs no signature,
 *    because a token that does not pay Stake is rejected however it was submitted.
 *  - `localStorage`, so the launcher still sees their own token if the API is briefly unreachable.
 *
 * Never throws: a launch that confirmed on chain must not appear to have failed because a listing
 * call did.
 */
export async function recordLaunch(rec: { address: string; reward: string; txHash: string }): Promise<void> {
  if (!isAddress(rec.address)) return
  const address = getAddress(rec.address)

  // Local first, and unconditionally: whatever happens next, the person who just paid for this
  // launch must see their token.
  const list = loadLaunched()
  if (!list.some((r) => r.address.toLowerCase() === address.toLowerCase())) {
    localStorage.setItem(
      LAUNCHED_KEY,
      JSON.stringify([{ address, reward: rec.reward, txHash: rec.txHash, at: Date.now() }, ...list]),
    )
  }

  /**
   * Then the shared registry, awaited and retried.
   *
   * ⚠ This used to be fire-and-forget. Two things went wrong with that. The listing is what makes
   * the token visible to anyone other than its launcher, so a silent failure meant a token that
   * looked listed to the one person who could not tell the difference. And the server verifies the
   * token by reading it on chain, which can briefly fail for a contract that was created seconds
   * ago — one attempt would give up on exactly the tokens this is for.
   *
   * Retried with backoff, and awaited so the caller does not navigate to a list that has not been
   * written yet. Never throws: a launch that succeeded on chain must not look like a failure
   * because a listing call did.
   */
  for (let attempt = 0; attempt < 4; attempt++) {
    const result = await submitToken({ address, reward: rec.reward })
    if (result.ok) return
    // 0.8s, 1.6s, 3.2s — long enough for a fresh contract to become readable.
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt))
  }
}

export type ManualEntry = {
  address: Address
  /** stock ticker this token pays out in. Not derivable on chain — the admin states it. */
  reward: string
  /** Optional override when the on-chain name is unhelpful. */
  note?: string
  addedAt: number
}

export type RegistryToken = OnChainToken & {
  /**
   * How this token got here.
   * - `launch`  — launched through Stake (recorded at confirmation)
   * - `manual`  — added by an admin
   * - `preview` — staged by `?preview=1`; real token, real chain reads, not a real listing
   * - `pinned`  — the Stake token itself; always listed, always first
   * - `shared`  — from the registry API, its fee route verified on chain and visible to everyone
   */
  source: 'launch' | 'manual' | 'preview' | 'pinned' | 'shared'
  reward: string | null
  note?: string
  priceUsd: number | null
  liquidityUsd: number | null
  mcapUsd: number | null
  /** From DexScreener — see `market.ts`. Null whenever it has nothing for this token. */
  change24h: number | null
  volume24hUsd: number | null
  createdAtMs: number | null
  /** Artwork and description, read straight off the token — see `enrichWithMeta`. */
  meta?: TokenMeta
}

/* ---------------------------------- manual list ---------------------------------- */

export function loadManual(): ManualEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as ManualEntry[]
    return Array.isArray(parsed) ? parsed.filter((e) => isAddress(e.address)) : []
  } catch {
    return []
  }
}

function saveManual(list: ManualEntry[]) {
  localStorage.setItem(KEY, JSON.stringify(list))
}

export function addManual(entry: { address: string; reward: string; note?: string }): ManualEntry {
  if (!isAddress(entry.address)) throw new Error('That is not a valid contract address.')
  const address = getAddress(entry.address)
  const list = loadManual()
  if (list.some((e) => e.address.toLowerCase() === address.toLowerCase())) {
    throw new Error('That token is already listed.')
  }
  const next: ManualEntry = { address, reward: entry.reward, note: entry.note, addedAt: Date.now() }
  saveManual([next, ...list])
  return next
}

export function removeManual(address: string) {
  saveManual(loadManual().filter((e) => e.address.toLowerCase() !== address.toLowerCase()))
}

/* ---------------------------------- assembly ---------------------------------- */

function withUsd(t: OnChainToken, nativeUsd: number | null, quotes: Record<string, Quote>) {
  // The pair may be quoted in BNB or in a stock, so the USD conversion uses whichever asset the
  // token actually trades against.
  const quoteUsd = t.quoteTicker ? (quotes[t.quoteTicker]?.priceUsd ?? null) : nativeUsd

  const priceUsd = t.priceQuote !== null && quoteUsd !== null ? t.priceQuote * quoteUsd : null
  const liquidityUsd = t.liquidityQuote !== null && quoteUsd !== null ? t.liquidityQuote * quoteUsd : null
  const supply = Number(t.totalSupply) / 10 ** t.decimals
  return {
    priceUsd,
    liquidityUsd,
    mcapUsd: priceUsd !== null && Number.isFinite(supply) ? priceUsd * supply : null,
    // Filled by the DexScreener pass once every address is known; null is the honest default if
    // that call fails, and the cards render dashes.
    change24h: null,
    volume24hUsd: null,
    createdAtMs: null,
  }
}

/**
 * Builds the full registry.
 *
 * Chain reads are per-token and run concurrently; a token that fails to read is dropped rather
 * than poisoning the whole list, because one dead contract should not empty the page.
 */
export async function buildRegistry(
  nativeUsd: number | null,
  quotes: Record<string, Quote>,
): Promise<RegistryToken[]> {
  const manual = loadManual()
  const launched = loadLaunched()

  // The shared registry is the real source of truth: these are visible to every visitor, and the
  // server verified each one's fee route against the chain before listing it. The localStorage
  // lists below remain only as a fallback, so a launcher still sees their own token if the API is
  // unreachable — `null` means exactly that, and is not the same as "there are none".
  const shared = await fetchListed()

  // ⛔ Never scan by the CONNECTED wallet. A token someone launched on pons outside Stake does
  // not route its creator fees here, so Stake has no fee stream to pay rewards from and staking it
  // would earn exactly nothing. Membership is "fees flow to Stake", not "this wallet deployed it".
  // The only deployer that qualifies is a custodial launcher wallet, if this deployment uses one.
  /**
   * ⛔ There is no browser-side launch scan on Robinhood Chain.
   *
   * The BNB build swept the launch topic for `BRAND.launcherWallets`. Here the public RPC caps
   * `eth_getLogs` at 2,000 blocks — about 3.3 minutes at ~100ms per block — so a sweep would cover
   * a rounding error of chain history and silently report almost nothing. Listings come from the
   * shared registry, from admin adds, and from launches recorded at confirmation.
   */

  // Precedence: a token recorded as launched here wins over a scan hit, which wins over a manual
  // add — so the same token never appears twice with a weaker label.
  const seen = new Set<string>()
  const take = (addr: string) => {
    const k = addr.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }

  const jobs: Promise<RegistryToken | null>[] = []

  // The Stake token is listed by identity, not by how it got here — it is the platform's own and
  // is always present. Taken first so nothing else can claim its address with a weaker source.
  //
  // With no address configured, `?preview=1` substitutes a stand-in contract purely so the card can
  // be reviewed fully populated. A real `tokenCa` always wins over it.
  const pin = pinnedAddress() ?? (previewOn() ? PREVIEW_PINNED_STANDIN : null)
  if (pin && take(pin)) {
    jobs.push(
      readToken(pin)
        .then((t): RegistryToken => ({
          ...t,
          ...withUsd(t, nativeUsd, quotes),
          source: 'pinned',
          // ⛔ Deliberately null, now and after `tokenCa` is set. The Stake token is not paired
          // against a stock, so whatever quote asset its pair happens to use must never be
          // presented as a reward ticker on its card.
          reward: null,
          name: BRAND.pinned.name,
          symbol: BRAND.pinned.symbol,
          meta: { imageUrl: BRAND.pinned.image, description: null, twitter: null, telegram: null, website: null },
        }))
        .catch(() => null),
    )
  }

  // ⚠⚠ AFTER the pinned block, never before. The Stake token routes its fees to Stake, so it
  // qualifies for the shared registry too and would be claimed here first — losing its pinned
  // card, losing the stock staking model, and gaining a reward badge it must never show. `take()`
  // is first-come, so this ordering is the guard.
  for (const entry of shared ?? []) {
    if (!take(entry.address)) continue
    jobs.push(
      readToken(entry.address)
        .then((t): RegistryToken => ({
          ...t,
          ...withUsd(t, nativeUsd, quotes),
          source: 'shared',
          reward: entry.reward ?? t.quoteTicker,
        }))
        .catch(() => null),
    )
  }

  /*
    ⭐ Every token launched through THIS SITE, straight off the locker's own reverse index.

    V1 takes the fee wallet as a launch parameter and only this site sets it to Stake's wallet, so
    `feeRecipientTokens(ourWallet, …)` IS the list of "launched here" — it needs no server and no
    log scan. That matters twice over: the shared registry verifies membership against the **V2**
    factory and so rejects every V1 token, and `eth_getLogs` is capped at 2,000 blocks (~3 minutes)
    on this chain, which rules out sweeping for them.

    ⚠ The picked stock is NOT on chain — V1 pairs against WETH — so `reward` comes from whatever
    local or shared record exists, and is left null when there is none rather than guessed from the
    pair, which would print WETH as though stakers were paid in it.
  */
  const v1Owned = await listV1TokensFor(LAUNCH_FEE_WALLET).catch(() => [])
  for (const addr of v1Owned) {
    if (!take(addr)) continue
    const known = launched.find((r) => r.address.toLowerCase() === addr.toLowerCase())
    jobs.push(
      readToken(addr)
        .then((t): RegistryToken => ({
          ...t,
          ...withUsd(t, nativeUsd, quotes),
          source: 'launch',
          reward: known?.reward ?? null,
        }))
        .catch(() => null),
    )
  }

  for (const rec of launched) {
    if (!take(rec.address)) continue
    jobs.push(
      readToken(rec.address)
        .then((t): RegistryToken => ({ ...t, ...withUsd(t, nativeUsd, quotes), source: 'launch', reward: rec.reward || t.quoteTicker }))
        .catch(() => null),
    )
  }


  for (const m of manual) {
    if (!take(m.address)) continue
    jobs.push(
      readToken(m.address)
        .then((t): RegistryToken => ({ ...t, ...withUsd(t, nativeUsd, quotes), source: 'manual', reward: m.reward, note: m.note }))
        .catch(() => null),
    )
  }

  // Preview rows come last so a real entry always wins the `take()` race against a preview one.
  // The chain read is identical to every other row — these are real tokens with real pairs, and
  // only their presence in the list is staged. Off entirely without `?preview=1`.
  if (previewOn()) {
    for (const p of PREVIEW_TOKENS) {
      if (!take(p.address)) continue
      jobs.push(
        readToken(p.address)
          .then((t): RegistryToken => ({ ...t, ...withUsd(t, nativeUsd, quotes), source: 'preview', reward: p.reward }))
          .catch(() => null),
      )
    }
  }

  const rows = (await Promise.all(jobs)).filter((r): r is RegistryToken => r !== null)

  // One HTTP call for the whole page. Chain stays the source of truth for price, liquidity and
  // market cap; this only supplies what current pool state cannot answer.
  const extras = await fetchMarketExtras(rows.map((r) => r.address))
  return rows.map((r) => ({ ...r, ...(extras[r.address.toLowerCase()] ?? {}) }))
}

/**
 * Fills in artwork and description for the rows already on screen.
 *
 * ⭐ One contract call per token. Pons stores `logo` and `description` as **plain strings on the
 * token itself**, set at launch — so this is a direct read that works forever.
 *
 * The BNB build needed roughly 16 RPC calls per token for the same thing: DexScreener for a
 * timestamp, a binary search to turn that timestamp into a block, a log scan around it to recover
 * the launch event, then an IPFS fetch for the document it pointed at. Every one of those steps
 * could fail, and when one did the token simply rendered with no image.
 */
export async function enrichWithMeta(
  rows: RegistryToken[],
  onEach: (address: Address, meta: TokenMeta) => void,
): Promise<void> {
  await Promise.all(
    rows.map(async (r) => {
      if (r.meta) return
      const art = await readTokenArt(r.address).catch(() => null)
      if (art?.logo || art?.description) {
        onEach(r.address, {
          imageUrl: art.logo,
          description: art.description,
          twitter: null,
          telegram: null,
          website: null,
        })
      }
    }),
  )
}
