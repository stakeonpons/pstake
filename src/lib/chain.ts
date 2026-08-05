import { createPublicClient, defineChain, fallback, http } from 'viem'

/**
 * BSC RPC endpoints, in preference order.
 *
 * ⚠ Every Binance dataseed (`bsc-dataseed*.binance.org`, defibit, ninicoin) **refuses
 * `eth_getLogs` outright** — "Request exceeds defined limit" — which makes them useless for the
 * launch scan. drpc / blockpi / ankr / llamarpc were dead when measured on 4 Aug 2026.
 *
 * These two work and **fail differently**, which is why both are here: publicnode is fast for
 * `getLogs` and flaky on single-transaction reads; nodereal is the reverse. viem's `fallback`
 * rotates on error.
 */
const ARCHIVE_RPC = (import.meta.env.VITE_ARCHIVE_RPC as string | undefined) ?? ''

/**
 * ⚠ The archive endpoint carries an API key, so it is read from the environment rather than
 * committed. Without it the app still works — every head-of-chain read goes to publicnode — but
 * historical lookups degrade, which in practice means token artwork stops resolving.
 */
export const BSC_RPCS = [
  'https://bsc-rpc.publicnode.com',
  ...(ARCHIVE_RPC ? [ARCHIVE_RPC] : []),
] as const

export const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [...BSC_RPCS] } },
  blockExplorers: { default: { name: 'BscScan', url: 'https://bscscan.com' } },
  contracts: {
    // Standard BSC deployment, used to batch token reads into one call.
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 15_921_452 },
  },
})

export const publicClient = createPublicClient({
  chain: bsc,
  transport: fallback(BSC_RPCS.map((url) => http(url, { timeout: 12_000 }))),
  batch: { multicall: true },
})

/**
 * A client for **historical** state — blocks and logs older than the last few hours.
 *
 * ⚠ publicnode is not an archive node. It answers `getLogs` near the head happily, then rejects
 * anything older with *"Archive requests require a personal token"* — which reads like a malformed
 * request rather than a missing capability, so it is worth naming. nodereal does serve archive
 * ranges (186 logs returned at ~24h back, measured 5 Aug 2026), so the order here is deliberately
 * the reverse of `publicClient`'s.
 *
 * Used to recover a token's launch event — and with it the metadata URI holding its image — long
 * after the launch. Do not point head-of-chain reads at this; `publicClient` is faster for those.
 */
export const archiveClient = createPublicClient({
  chain: bsc,
  transport: fallback([...BSC_RPCS].reverse().map((url) => http(url, { timeout: 20_000 }))),
})

export const CHAIN_ID_HEX = '0x38'

/** Params for `wallet_addEthereumChain`, for wallets that do not know BSC yet. */
export const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: [...BSC_RPCS],
  blockExplorerUrls: ['https://bscscan.com'],
} as const

export function explorerToken(address: string): string {
  return `https://bscscan.com/token/${address}`
}

export function explorerTx(hash: string): string {
  return `https://bscscan.com/tx/${hash}`
}
