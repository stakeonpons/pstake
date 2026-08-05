/**
 * Preview mode.
 *
 * A review aid used while building, compiled out of production builds and not part of the published
 * app. These stubs keep the shape the rest of the app expects.
 */

import type { Address } from 'viem'

export function previewOn(): boolean {
  return false
}

export type PreviewToken = { address: Address; reward: string }

export const PREVIEW_TOKENS: readonly PreviewToken[] = []
export const PREVIEW_PINNED_STANDIN = '' as Address
export const PREVIEW_BALANCES: Record<string, number> = {}
