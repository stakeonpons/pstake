/**
 * A token's tax settings, read from the token itself.
 *
 * flap's Tax Token V3 exposes `buyTaxRate()`, `sellTaxRate()` and `antiFarmerDuration()`, so what a
 * token actually charges is verifiable on chain rather than taken on trust from launch calldata.
 * Confirmed against a live token (ROBIN read back 100 / 100 / 2592000, matching its own launch).
 *
 * This is also how a bStake launch is audited after the fact: read the token back and the policy's
 * 200 / 200 / 0 should be staring at you.
 *
 * Returns null when the token is not a tax token — a standard flap token has none of these
 * functions, and that is an ordinary outcome, not an error.
 */

import { parseAbi, type Address } from 'viem'
import { publicClient } from './chain'

const TAX_ABI = parseAbi([
  'function buyTaxRate() view returns (uint16)',
  'function sellTaxRate() view returns (uint16)',
  'function antiFarmerDuration() view returns (uint64)',
])

export type TokenTaxes = {
  buyTaxBps: number
  sellTaxBps: number
  antiFarmerSeconds: number
}

export async function readTokenTaxes(address: Address): Promise<TokenTaxes | null> {
  try {
    const [buy, sell, anti] = await Promise.all([
      publicClient.readContract({ address, abi: TAX_ABI, functionName: 'buyTaxRate' }),
      publicClient.readContract({ address, abi: TAX_ABI, functionName: 'sellTaxRate' }),
      publicClient.readContract({ address, abi: TAX_ABI, functionName: 'antiFarmerDuration' }),
    ])
    return { buyTaxBps: Number(buy), sellTaxBps: Number(sell), antiFarmerSeconds: Number(anti) }
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------------------------------------- */

/**
 * flap's Tax Token Helper — cumulative, per-token tax accounting, read straight off chain.
 *
 * This is the answer to "how much has this token actually paid its beneficiary". No indexing, no
 * estimating from volume, no tracing transfers: the protocol keeps the running totals itself.
 *
 * Verified against three live tokens on 5 Aug 2026, and the numbers cross-check against each
 * token's own allocation: CLIPPY splits 50/50 marketing/dividend and reports an identical total in
 * both buckets, while ROBIN and GPU allocate 0% to marketing and report exactly zero there.
 */
const HELPER = '0x53841c73217735F37BC1775538b03b23feFD8346' as const

// prettier-ignore
const HELPER_ABI = parseAbi([
  'function getTaxTokenInfo(address taxToken) view returns ((uint16 marketBps, uint16 deflationBps, uint16 lpBps, uint16 dividendBps, uint16 taxRate, uint256 burntTokenAmount, uint256 totalQuoteSentToDividend, uint256 totalQuoteAddedToLiquidity, uint256 totalTokenAddedToLiquidity, uint256 totalQuoteSentToMarketing, address marketingWallet, address quoteToken, uint256 minimumShareBalance) info)',
])

export type TaxTokenInfo = {
  /** Share of tax routed to the beneficiary, in bps. flap's UI calls this the Creator Funds Wallet. */
  marketBps: number
  deflationBps: number
  lpBps: number
  dividendBps: number
  /** ⚠ The BENEFICIARY. This is what identifies a token as routing its fees to bStake. */
  marketingWallet: Address
  quoteToken: Address
  /** Cumulative quote tokens paid to the beneficiary, in the quote asset's own smallest unit. */
  totalQuoteSentToMarketing: bigint
  totalQuoteSentToDividend: bigint
  burntTokenAmount: bigint
}

/** Null for a token the helper does not recognise, which is an ordinary outcome, not an error. */
export async function readTaxTokenInfo(address: Address): Promise<TaxTokenInfo | null> {
  try {
    const i = await publicClient.readContract({
      address: HELPER,
      abi: HELPER_ABI,
      functionName: 'getTaxTokenInfo',
      args: [address],
    })
    return {
      marketBps: Number(i.marketBps),
      deflationBps: Number(i.deflationBps),
      lpBps: Number(i.lpBps),
      dividendBps: Number(i.dividendBps),
      marketingWallet: i.marketingWallet,
      quoteToken: i.quoteToken,
      totalQuoteSentToMarketing: i.totalQuoteSentToMarketing,
      totalQuoteSentToDividend: i.totalQuoteSentToDividend,
      burntTokenAmount: i.burntTokenAmount,
    }
  } catch {
    return null
  }
}
