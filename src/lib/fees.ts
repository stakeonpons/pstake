/**
 * Creator fees on Pons — where they accrue, who can claim them, and what is honestly readable.
 *
 * ## ⚠⚠ A claimable balance is not a lifetime total, and the difference changes what the UI can claim
 *
 * A transfer-tax launchpad can keep a **cumulative total per token**, so every token page can show
 * exactly what that token has paid. Pons keeps no such figure.
 *
 * Pons routes fees through a **fee escrow keyed by (recipient, asset)** — `balanceOfToken(account,
 * token)`. It is a claimable balance, not a per-token ledger:
 *
 *  - Two pStake tokens paired against the same stock pay into the **same** balance.
 *  - Claiming resets it, so it is not a lifetime total either.
 *
 * ⛔ Therefore **a per-token "fees earned so far" figure cannot be read on this chain** and must
 * not be invented by multiplying volume by a tax rate — that estimate drifts from the truth the
 * moment anything is claimed or routed elsewhere. What is real, and what this module exposes: the
 * token's tax RATE and fee policy (from the launch record) and the CLAIMABLE balance per stock
 * (from the escrow). Anything else renders a dash.
 */

import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { publicClient } from './chain'
import { PONS, FACTORY_ABI, LAUNCH_POLICY } from './pons'
import { STOCKS } from './stocks'

/**
 * Pons's fee escrow.
 *
 * ⚠ Found via `factory.feeEscrow()`, not assumed: the V2 **locker holds only the LP position**
 * (`lockedPositions` / `isLocked`) and has no `collectFees` at all. Porting V1's locker-based claim
 * path — which is what the older Pons integrations on this machine use — would read zero forever.
 */
export const FEE_ESCROW = '0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c' as const

const ESCROW_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function balanceOfToken(address account, address token) view returns (uint256)',
  'function claim()',
  'function claimToken(address token)',
])

export type TokenFeeTerms = {
  /** Creator tax in bps, set at launch. 200 = 2%. */
  creatorTaxBps: number
  /** The pons hook's own cut, in bps. Independent of the creator tax. */
  hookFeeBps: number
  buybackBurnBps: number
  /** ⭐ Who the creator fees pay. The membership test — see `isOurs`. */
  creatorFeeRecipient: Address
}

/** The fee terms a token launched with. Null for anything not launched on Pons V2. */
export async function readFeeTerms(token: Address): Promise<TokenFeeTerms | null> {
  try {
    const [launch, policy] = await Promise.all([
      publicClient.readContract({
        address: PONS.factory as Address,
        abi: FACTORY_ABI,
        functionName: 'getLaunchedToken',
        args: [token],
      }),
      publicClient
        .readContract({
          address: PONS.factory as Address,
          abi: FACTORY_ABI,
          functionName: 'getLaunchFeePolicy',
          args: [token],
        })
        .catch(() => null),
    ])
    if (!launch.exists) return null
    return {
      creatorTaxBps: Number(launch.creatorTaxBps),
      hookFeeBps: policy ? Number(policy.hookFeeBps) : 0,
      buybackBurnBps: policy ? Number(policy.buybackBurnBps) : 0,
      creatorFeeRecipient: launch.creatorFeeRecipient,
    }
  } catch {
    return null
  }
}

/**
 * Whether a token routes its creator fees to pStake.
 *
 * ⚠⚠ **Not immutable.** The factory exposes
 * `executeCreatorFeeRecipientChange` behind `CREATOR_FEE_RECIPIENT_TIMELOCK`, so a creator can move
 * the fees away — with a delay, but they can. Read this live every time and never render it as a
 * guarantee; a cached "yes" would be a promise the chain has stopped keeping.
 *
 * Returns null for "cannot determine", never false.
 */
export async function isOurs(token: Address): Promise<boolean | null> {
  const terms = await readFeeTerms(token)
  if (!terms) return null
  return terms.creatorFeeRecipient.toLowerCase() === LAUNCH_POLICY.creatorFeeRecipient.toLowerCase()
}

export type ClaimableRow = {
  ticker: string
  address: Address
  amount: bigint
  decimals: number
}

/**
 * What a recipient can claim right now, per stock, plus the native balance.
 *
 * This is the real, current money — the number the Rewards page is built on. It is a claimable
 * balance, so it goes to zero when claimed; it is not a lifetime earnings figure and must never be
 * labelled as one.
 */
export async function readClaimable(account: Address): Promise<{ native: bigint; rows: ClaimableRow[] }> {
  const [native, ...amounts] = await Promise.all([
    publicClient
      .readContract({ address: FEE_ESCROW, abi: ESCROW_ABI, functionName: 'balanceOf', args: [account] })
      .catch(() => 0n),
    ...STOCKS.map((s) =>
      publicClient
        .readContract({
          address: FEE_ESCROW,
          abi: ESCROW_ABI,
          functionName: 'balanceOfToken',
          args: [account, s.address as Address],
        })
        .catch(() => 0n),
    ),
  ])

  const rows: ClaimableRow[] = STOCKS.map((s, i) => ({
    ticker: s.ticker,
    address: s.address as Address,
    amount: (amounts[i] as bigint) ?? 0n,
    decimals: s.decimals,
  }))

  return { native: native as bigint, rows }
}

/**
 * Builds the claim transaction for one stock.
 *
 * The escrow credits the RECIPIENT, and `claimToken` claims for `msg.sender`, so this only does
 * anything when signed by the fee recipient itself. That is the same non-custodial shape as the
 * launcher: pStake builds the calldata, the wallet that owns the money signs it.
 */
export function buildClaim(stockAddress: Address): { to: Address; data: Hex } {
  return {
    to: FEE_ESCROW,
    data: encodeFunctionData({ abi: ESCROW_ABI, functionName: 'claimToken', args: [stockAddress] }),
  }
}

export { ESCROW_ABI }
