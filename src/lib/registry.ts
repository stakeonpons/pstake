/**
 * The token registry behind /tokens.
 *
 * ## What makes a token "ours"
 *
 * Creators launch from **their own wallet** — bStake builds the transaction, their wallet signs and
 * pays for it. So the `deployer` in a flap launch event is a different address every time and says
 * nothing about whether the launch came through this site. Filtering on it cannot work.
 *
 * The durable answer is the **fee beneficiary**, which is nominated inside the launch transaction.
 * A token whose beneficiary is `LAUNCH_POLICY.feeRecipient` pays its creator fees to bStake's
 * stakers, and that is precisely what qualifies it — whether it was launched here, or launched on
 * flap and pointed here afterwards. Ownership of the click is irrelevant; the fee route is the
 * product.
 *
 * ✅ `isOurs()` reads that beneficiary on chain — flap's Tax Token Helper exposes it as
 * `marketingWallet` — so membership is now verifiable rather than asserted. What still needs
 * solving is DISCOVERY: knowing an address is ours is easy, enumerating every token that points at
 * us is not, because it means scanning every flap launch. Until that exists the list comes from:
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
import { readToken, scanLaunches, type LaunchEvent, type OnChainToken } from './flapIndexer'
import { PREVIEW_PINNED_STANDIN, PREVIEW_TOKENS, previewOn } from './preview'
import { pinnedAddress } from './pinned'
import { fetchMarketExtras } from './market'
import { fetchTokenMeta, type TokenMeta } from './tokenMeta'
import { fetchListed, submitToken } from './registryApi'
import { readTaxTokenInfo } from './tax'
import { LAUNCH_POLICY } from './flap'
import type { Quote } from './stocks'

export const MANUAL_STORAGE_NOTE =
  'Kept in this browser as a fallback. The shared registry is what other visitors see.'

const KEY = 'bstake.manual-tokens.v1'
const LAUNCHED_KEY = 'bstake.launched-here.v1'

/**
 * Whether a token's creator fees are routed to bStake — the real membership test.
 *
 * ✅ Implemented 5 Aug 2026. flap's Tax Token Helper reports each token's `marketingWallet`, which
 * IS the beneficiary nominated at launch, so membership is a direct on-chain comparison against
 * `LAUNCH_POLICY.feeRecipient`. Confirmed by reading a live token back and matching it to the
 * beneficiary in its own launch calldata.
 *
 * This is stronger than a list: it holds for a token launched here, a token launched on flap and
 * pointed here afterwards, and it cannot be faked by adding an address to `localStorage`.
 *
 * Still returns null when the helper does not recognise the token — "cannot determine" is not the
 * same as "no", and the two must not collapse into one another.
 */
export async function isOurs(token: Address): Promise<boolean | null> {
  const info = await readTaxTokenInfo(token)
  if (!info) return null
  return info.marketingWallet.toLowerCase() === LAUNCH_POLICY.feeRecipient.toLowerCase()
}

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
 * Records a token launched through bStake, the moment its transaction confirms.
 *
 * Writes to **both** places, on purpose:
 *  - the shared registry, so every visitor sees the token. The server re-verifies the fee route
 *    against the chain, so this is a submission, not an assertion — and it needs no signature,
 *    because a token that does not pay bStake is rejected however it was submitted.
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
  /** bStock ticker this token pays out in. Not derivable on chain — the admin states it. */
  reward: string
  /** Optional override when the on-chain name is unhelpful. */
  note?: string
  addedAt: number
}

export type RegistryToken = OnChainToken & {
  /**
   * How this token got here.
   * - `launch`  — launched through bStake (recorded at confirmation)
   * - `manual`  — added by an admin
   * - `preview` — staged by `?preview=1`; real token, real chain reads, not a real listing
   * - `pinned`  — the bStake token itself; always listed, always first
   * - `shared`  — from the registry API, its fee route verified on chain and visible to everyone
   */
  source: 'launch' | 'manual' | 'preview' | 'pinned' | 'shared'
  reward: string | null
  note?: string
  launch?: LaunchEvent
  priceUsd: number | null
  liquidityUsd: number | null
  mcapUsd: number | null
  /** From DexScreener — see `market.ts`. Null whenever it has nothing for this token. */
  change24h: number | null
  volume24hUsd: number | null
  createdAtMs: number | null
  /** Artwork and socials, filled in a second pass — see `enrichWithMeta`. */
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

function withUsd(t: OnChainToken, bnbUsd: number | null, quotes: Record<string, Quote>) {
  // The pair may be quoted in BNB or in a bStock, so the USD conversion uses whichever asset the
  // token actually trades against.
  const quoteUsd = t.quoteTicker ? (quotes[t.quoteTicker]?.priceUsd ?? null) : bnbUsd

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
  bnbUsd: number | null,
  quotes: Record<string, Quote>,
): Promise<RegistryToken[]> {
  const manual = loadManual()
  const launched = loadLaunched()

  // The shared registry is the real source of truth: these are visible to every visitor, and the
  // server verified each one's fee route against the chain before listing it. The localStorage
  // lists below remain only as a fallback, so a launcher still sees their own token if the API is
  // unreachable — `null` means exactly that, and is not the same as "there are none".
  const shared = await fetchListed()

  // ⛔ Never scan by the CONNECTED wallet. A token someone launched on flap outside bStake does
  // not route its creator fees here, so bStake has no fee stream to pay rewards from and staking it
  // would earn exactly nothing. Membership is "fees flow to bStake", not "this wallet deployed it".
  // The only deployer that qualifies is a custodial launcher wallet, if this deployment uses one.
  const scanned = BRAND.launcherWallets.length
    ? await scanLaunches({ deployers: BRAND.launcherWallets })
    : []

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

  // The bStake token is listed by identity, not by how it got here — it is the platform's own and
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
          ...withUsd(t, bnbUsd, quotes),
          source: 'pinned',
          // ⛔ Deliberately null, now and after `tokenCa` is set. The bStake token is not paired
          // against a bStock, so whatever quote asset its pair happens to use must never be
          // presented as a reward ticker on its card.
          reward: null,
          name: BRAND.pinned.name,
          symbol: BRAND.pinned.symbol,
          meta: { imageUrl: BRAND.pinned.image, description: null, twitter: null, telegram: null, website: null },
        }))
        .catch(() => null),
    )
  }

  // ⚠⚠ AFTER the pinned block, never before. The bStake token routes its fees to bStake, so it
  // qualifies for the shared registry too and would be claimed here first — losing its pinned
  // card, losing the bStock staking model, and gaining a reward badge it must never show. `take()`
  // is first-come, so this ordering is the guard.
  for (const entry of shared ?? []) {
    if (!take(entry.address)) continue
    jobs.push(
      readToken(entry.address)
        .then((t): RegistryToken => ({
          ...t,
          ...withUsd(t, bnbUsd, quotes),
          source: 'shared',
          reward: entry.reward ?? t.quoteTicker,
        }))
        .catch(() => null),
    )
  }

  for (const rec of launched) {
    if (!take(rec.address)) continue
    jobs.push(
      readToken(rec.address)
        .then((t): RegistryToken => ({ ...t, ...withUsd(t, bnbUsd, quotes), source: 'launch', reward: rec.reward || t.quoteTicker }))
        .catch(() => null),
    )
  }

  for (const l of scanned) {
    if (!take(l.token)) continue
    const m = manual.find((x) => x.address.toLowerCase() === l.token.toLowerCase())
    jobs.push(
      readToken(l.token)
        .then((t): RegistryToken => ({
          ...t,
          ...withUsd(t, bnbUsd, quotes),
          source: 'launch',
          reward: m?.reward ?? t.quoteTicker,
          launch: l,
        }))
        .catch(() => null),
    )
  }

  for (const m of manual) {
    if (!take(m.address)) continue
    jobs.push(
      readToken(m.address)
        .then((t): RegistryToken => ({ ...t, ...withUsd(t, bnbUsd, quotes), source: 'manual', reward: m.reward, note: m.note }))
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
          .then((t): RegistryToken => ({ ...t, ...withUsd(t, bnbUsd, quotes), source: 'preview', reward: p.reward }))
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
 * Second pass: token artwork and socials.
 *
 * Separate from `buildRegistry` on purpose. Each lookup is a timestamp binary search plus a log
 * scan plus an HTTP fetch — around 16 RPC calls and ~650ms per token — so making the grid wait for
 * it would leave the page blank for seconds. Cards render immediately with a symbol monogram and
 * swap in artwork as it arrives.
 *
 * Results are cached for a month in `localStorage`, so this is a first-visit cost only.
 */
export async function enrichWithMeta(
  rows: RegistryToken[],
  onEach: (address: Address, meta: TokenMeta) => void,
): Promise<void> {
  await Promise.all(
    rows.map(async (r) => {
      if (r.meta) return
      const meta = await fetchTokenMeta(r.address, r.createdAtMs)
      if (meta.imageUrl || meta.twitter || meta.telegram || meta.website) onEach(r.address, meta)
    }),
  )
}
