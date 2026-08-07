/**
 * The two staking models, and which token uses which.
 *
 * ## ⚠⚠ These are not variations of one thing. They are different products.
 *
 * | | What you stake | What funds the rewards | What you are paid in |
 * | --- | --- | --- | --- |
 * | **`launched`** | that token itself | that token's own trading fees | the one stock it is paired against |
 * | **`pstake`** | **any stock** | **the Stake token's** trading fees | stocks |
 *
 * `launched` applies to every token launched through the platform. `pstake` applies to **exactly
 * one token — Stake's own** — and to nothing else, ever.
 *
 * The operator has been explicit about this twice, and the site's copy has described both tracks
 * since it was built. Merging them, or letting the wrong one appear on the wrong token, would
 * misrepresent where somebody's money goes.
 *
 * ## Why it keys off the pinned address
 *
 * `BRAND.tokenCa` is the single definition of "our token" already — it drives the CA pill and the
 * pinned card. Reusing it means there is no second place to keep in sync, and no token can adopt
 * the Stake model by accident: an address either is `BRAND.tokenCa` or it is not.
 *
 * ## ✏️ 7 Aug — Stake IS stakeable now, reversing the earlier rule
 *
 * This file used to say "Stake itself is not stakeable" and `/stake` excluded it, on the operator's
 * twice-stated instruction. **They reversed that deliberately**: staking $STAKE to earn $STAKE is
 * the route for handing the token's own fee revenue back to holders, and pool 8 in `Deploy.s.sol`
 * exists for it. ⛔ Do not "restore" the exclusion — it was a decision, not a bug.
 *
 * ⚠ The two tracks above still stand and are still distinct. The Stake token now simply appears in
 * both: its fees fund the stock pools, AND it can be staked in its own pool. What it must never do
 * is adopt the `launched` model on its token page, because it is not paired against a stock.
 *
 * ⚠ Stake is paired against the chain's native asset, not a stock, so its fees accrue in ETH.
 * Every read that assumes a stock quote has to tolerate that — see `quoteTicker === null` handling.
 */

import { isPinned } from './pinned'

export type StakingModel =
  /** Stake the token itself; earn its fees in its paired stock. */
  | 'launched'
  /** Stake any stock; earn from the Stake token's fees. Only ever the Stake token. */
  | 'pstake'

export function stakingModelFor(address: string): StakingModel {
  return isPinned(address) ? 'pstake' : 'launched'
}

/**
 * Whether a token can itself be staked.
 *
 * ✏️ Now true for EVERY token including Stake's own — see the reversal noted above. Kept as a
 * function rather than inlined as `true` because it is the one place the rule lives, and the next
 * change to it should happen here rather than in two page components.
 */
export function isStakeable(_address: string): boolean {
  return true
}
