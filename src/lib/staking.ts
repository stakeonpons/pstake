/**
 * The two staking models, and which token uses which.
 *
 * ## ⚠⚠ These are not variations of one thing. They are different products.
 *
 * | | What you stake | What funds the rewards | What you are paid in |
 * | --- | --- | --- | --- |
 * | **`launched`** | that token itself | that token's own trading fees | the one bStock it is paired against |
 * | **`bstake`** | **any bStock** | **the bStake token's** trading fees | bStocks |
 *
 * `launched` applies to every token launched through the platform. `bstake` applies to **exactly
 * one token — bStake's own** — and to nothing else, ever.
 *
 * The operator has been explicit about this twice, and the site's copy has described both tracks
 * since it was built. Merging them, or letting the wrong one appear on the wrong token, would
 * misrepresent where somebody's money goes.
 *
 * ## Why it keys off the pinned address
 *
 * `BRAND.tokenCa` is the single definition of "our token" already — it drives the CA pill and the
 * pinned card. Reusing it means there is no second place to keep in sync, and no token can adopt
 * the bStake model by accident: an address either is `BRAND.tokenCa` or it is not.
 *
 * ⚠ Consequences elsewhere, both load-bearing:
 *  - **bStake itself is not stakeable.** `/stake` must exclude it from the stakeable list, or the
 *    site would offer exactly the thing this model says is impossible.
 *  - bStake is paired against **BNB**, not a bStock, so its fees accrue in BNB. Every read that
 *    assumes a bStock quote has to tolerate that — see `quoteTicker === null` handling.
 */

import { isPinned } from './pinned'

export type StakingModel =
  /** Stake the token itself; earn its fees in its paired bStock. */
  | 'launched'
  /** Stake any bStock; earn from the bStake token's fees. Only ever the bStake token. */
  | 'bstake'

export function stakingModelFor(address: string): StakingModel {
  return isPinned(address) ? 'bstake' : 'launched'
}

/**
 * Whether a token can itself be staked.
 *
 * False for the bStake token: its holders do not stake it, bStock holders stake *instead* and are
 * paid from its fees.
 */
export function isStakeable(address: string): boolean {
  return stakingModelFor(address) === 'launched'
}
