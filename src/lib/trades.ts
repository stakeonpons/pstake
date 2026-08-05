/**
 * Recent trades for a token, read from its own pair's `Swap` events.
 *
 * ## ⚠⚠ Which side is which
 *
 * A Uniswap-V2 `Swap` carries four amounts: `amount0In, amount1In, amount0Out, amount1Out`. Whether
 * our token is token0 or token1 is a property of the pair, decided by address ordering, and it
 * flips from pair to pair. Reading the wrong side turns every buy into a sell and every sell into a
 * buy — silently, with plausible-looking numbers. So `token0()` is read once and the sides are
 * assigned from it rather than assumed.
 *
 * This is the same failure that inverted every trade in the V4 swap decoder on another project.
 * There is no way to notice it by eye; the only defence is deriving the side from the pair.
 *
 * ## Scope
 *
 * A bounded window near the head of the chain, so it works on the ordinary RPC without archive
 * access. It is "recent trades", not history — anything wanting the full life of a token needs a
 * server-side indexer.
 */

import { parseAbi, type Address } from 'viem'
import { publicClient } from './chain'

const PAIR_ABI = parseAbi([
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'function token0() view returns (address)',
])

export type Trade = {
  kind: 'buy' | 'sell'
  /** Token amount, in whole tokens. */
  amount: number
  /** Quote-asset amount paid or received, in whole units. */
  quoteAmount: number
  blockNumber: bigint
  txHash: string
  trader: Address
}

/**
 * Reads recent swaps for a pair.
 *
 * `blocks` is deliberately modest: BSC produces a block roughly every 0.75s, so 20,000 blocks is
 * about four hours. Chunked because public endpoints cap the range, and a chunk that fails is
 * skipped rather than failing the whole read.
 */
export async function readRecentTrades(args: {
  pair: Address
  token: Address
  tokenDecimals: number
  quoteDecimals: number
  blocks?: number
  limit?: number
}): Promise<Trade[]> {
  const { pair, token, tokenDecimals, quoteDecimals, blocks = 20_000, limit = 30 } = args

  const token0 = await publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })
  // ⚠ The side assignment. Everything below depends on this being read, not guessed.
  const tokenIsZero = token0.toLowerCase() === token.toLowerCase()

  const head = await publicClient.getBlockNumber()
  const from = head > BigInt(blocks) ? head - BigInt(blocks) : 0n

  const CHUNK = 2_000n
  const ranges: [bigint, bigint][] = []
  for (let start = from; start <= head; start += CHUNK) {
    ranges.push([start, start + CHUNK - 1n > head ? head : start + CHUNK - 1n])
  }

  const batches = await Promise.all(
    ranges.map(([fromBlock, toBlock]) =>
      publicClient
        .getLogs({ address: pair, event: PAIR_ABI[0], fromBlock, toBlock })
        .catch(() => []),
    ),
  )

  const trades: Trade[] = []
  for (const log of batches.flat()) {
    const a = log.args as {
      amount0In?: bigint; amount1In?: bigint; amount0Out?: bigint; amount1Out?: bigint; to?: Address
    }
    const tokenIn = (tokenIsZero ? a.amount0In : a.amount1In) ?? 0n
    const tokenOut = (tokenIsZero ? a.amount0Out : a.amount1Out) ?? 0n
    const quoteIn = (tokenIsZero ? a.amount1In : a.amount0In) ?? 0n
    const quoteOut = (tokenIsZero ? a.amount1Out : a.amount0Out) ?? 0n

    // Tokens leaving the pair means someone bought them.
    const isBuy = tokenOut > 0n
    const amountRaw = isBuy ? tokenOut : tokenIn
    const quoteRaw = isBuy ? quoteIn : quoteOut
    if (amountRaw === 0n) continue

    trades.push({
      kind: isBuy ? 'buy' : 'sell',
      amount: Number(amountRaw) / 10 ** tokenDecimals,
      quoteAmount: Number(quoteRaw) / 10 ** quoteDecimals,
      blockNumber: log.blockNumber ?? 0n,
      txHash: log.transactionHash ?? '',
      trader: a.to ?? ('0x' as Address),
    })
  }

  trades.sort((x, y) => Number(y.blockNumber - x.blockNumber))
  return trades.slice(0, limit)
}

/**
 * A price series for a sparkline, oldest first, denominated in the quote asset.
 *
 * Derived from the same swaps: each one prices the token at that moment. Returns an empty array
 * when there are too few trades to draw a meaningful line, rather than a flat or invented one.
 */
export function priceSeries(trades: Trade[]): number[] {
  const points = [...trades]
    .reverse()
    .filter((t) => t.amount > 0 && t.quoteAmount > 0)
    .map((t) => t.quoteAmount / t.amount)
  return points.length >= 3 ? points : []
}
