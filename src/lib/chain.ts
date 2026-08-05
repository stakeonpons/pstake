import { createPublicClient, defineChain, fallback, http } from 'viem'

/**
 * Robinhood Chain.
 *
 * ⚠⚠ **This chain makes a block roughly every 100ms — about 861,000 blocks a day — and the public
 * RPC caps `eth_getLogs` at 2,000 blocks, i.e. about 3.3 minutes of history.** That single fact
 * decides the architecture of everything that reads history here:
 *
 *  - A browser cannot reconstruct a token's trade history or find its launch by scanning. On BNB
 *    that was ~16 calls; here a day of history is 861,000 blocks, and the endpoint refuses ranges
 *    past 2,000 anyway.
 *  - So **history comes from an indexer or from DexScreener, never from a browser-side scan.**
 *    Present state — balances, pool price, fee totals, who a token pays — is still read live from
 *    contracts, because that costs one call regardless of how old the chain is.
 *
 * State is also pruned on the public endpoint, so a historical `eth_call` at an old block fails.
 * Nothing here does that; anything that starts to will need an archive provider.
 */
const EXTRA_RPC = (import.meta.env.VITE_RHC_RPC as string | undefined) ?? ''

/**
 * ⚠ `rpc.robinhood.com` does NOT resolve — the working host is `rpc.mainnet.chain.robinhood.com`.
 * An extra endpoint can be supplied from the environment; it is optional, and without it every
 * read goes to the public one.
 */
export const RHC_RPCS = [
  'https://rpc.mainnet.chain.robinhood.com',
  ...(EXTRA_RPC ? [EXTRA_RPC] : []),
] as const

export const rhc = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [...RHC_RPCS] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
})

export const publicClient = createPublicClient({
  chain: rhc,
  transport: fallback(RHC_RPCS.map((url) => http(url, { timeout: 12_000 }))),
  batch: { multicall: true },
})

/**
 * Blockscout's REST API.
 *
 * Two jobs with no on-chain answer: the **USD price of a tokenized stock** (`exchange_rate` on the
 * token endpoint) and metadata for assets not launched through Pons. It serves CORS `*`, so the
 * browser calls it directly.
 *
 * ⚠ This is the price source that replaces Binance. Robinhood's tokenized equities are not listed
 * on Binance under these tickers, and inventing a mapping to some Binance market would be printing
 * the price of a different asset.
 */
export const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'

export const CHAIN_ID_HEX = '0x1237'

/** Params for `wallet_addEthereumChain`, for wallets that do not know Robinhood Chain yet. */
export const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [...RHC_RPCS],
  blockExplorerUrls: [BLOCKSCOUT],
} as const

export function explorerToken(address: string): string {
  return `${BLOCKSCOUT}/token/${address}`
}

export function explorerTx(hash: string): string {
  return `${BLOCKSCOUT}/tx/${hash}`
}

export function explorerAddress(address: string): string {
  return `${BLOCKSCOUT}/address/${address}`
}
