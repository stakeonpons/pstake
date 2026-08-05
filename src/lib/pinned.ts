/**
 * The bStake token's own listing.
 *
 * bStake's token is the first launched on the platform, so on /tokens it is **always first and
 * always visible** — search and reward filters skip it rather than hide it, and its card is
 * outlined so it is identifiable at a glance.
 *
 * Everything numeric on that card is live: it goes through `readToken` and the DexScreener pass
 * like every other row. Only the artwork, name and symbol are supplied here, because they are the
 * brand's, not whatever a metadata document happens to say.
 *
 * ➤ Switching it on is one string: `BRAND.tokenCa` in `brand.ts`.
 */

import { getAddress, isAddress, type Address } from 'viem'
import { BRAND } from '../brand'

/**
 * The pinned token's address, or null while `tokenCa` is unset.
 *
 * ⚠ The address is **lowercased before validation**, deliberately. `isAddress` is strict about
 * EIP-55 checksums, so a perfectly valid address copied from a block explorer, a wallet, or a chat
 * message in the wrong case would be rejected — and the failure is silent: no pinned card, no
 * bStake staking model, no error anywhere. Since the whole feature switches on this one string,
 * that is far too quiet a way to fail. Lowercasing first accepts any casing, and `getAddress`
 * then returns it properly checksummed.
 *
 * Genuinely malformed values still return null, which is the intended "not configured yet" state.
 */
export function pinnedAddress(): Address | null {
  const ca = BRAND.tokenCa?.trim().toLowerCase()
  if (!ca || !isAddress(ca)) return null
  return getAddress(ca)
}

export function isPinned(address: string): boolean {
  const pin = pinnedAddress()
  return !!pin && pin.toLowerCase() === address.toLowerCase()
}
