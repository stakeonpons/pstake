/**
 * Token artwork and socials — the off-chain half of a token's identity.
 *
 * ## Where an image actually comes from
 *
 * A flap.sh launch event carries a **metadata URI** as its last field (see `decodeLaunchLog`). That
 * document holds the image. Nothing else exposes it: the token contract has no `uri()`,
 * `tokenURI()`, `metadata()` or any of eleven other candidates (probed against a live token), the
 * Portal exposes no per-token getter, and flap.sh's own site sends no CORS headers so the browser
 * cannot read it. The launch event is the only path.
 *
 * ## Why finding the event is the hard part
 *
 * Given only a contract address, the launch event could be in any block. Scanning is hopeless —
 * the Portal emits ~5 matching logs per block. So the block is located by **timestamp**: DexScreener
 * reports when the pair was created, a binary search converts that to a block number, and a ±12
 * block window around it is scanned. Measured on three live tokens: 16–17 RPC calls and ~650ms
 * each, landing inside the first window every time.
 *
 * ⚠ This needs an **archive** node — see `archiveClient`. publicnode refuses historical ranges.
 *
 * ## What is trusted from the metadata, and what is not
 *
 * Only the **image and the social links**. Name and symbol come from the contract, because the
 * metadata document is frequently wrong: two of three live tokens sampled had empty `name` and
 * `symbol` fields while carrying a perfectly good image. On-chain `name()`/`symbol()` are
 * authoritative and already read.
 */

import type { Address, Hex } from 'viem'
import { archiveClient } from './chain'
import { FLAP } from './flap'
import { LAUNCH_TOPIC0, decodeLaunchLog } from './flapIndexer'

const CACHE_KEY = 'bstake.token-meta.v1'

export type TokenMeta = {
  /** Direct, loadable image URL. Null when the token published none, or it could not be read. */
  imageUrl: string | null
  description: string | null
  twitter: string | null
  telegram: string | null
  website: string | null
}

const EMPTY: TokenMeta = { imageUrl: null, description: null, twitter: null, telegram: null, website: null }

/** Gateways are tried in order; the first that answers wins. */
const IPFS_GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/']

/**
 * Turns whatever the launch event stored into something loadable.
 *
 * The field is a URI, not necessarily a CID: live tokens carry bare CIDs (`bafkrei…`), `ipfs://`
 * URLs, and plain HTTPS URLs to third-party metadata hosts. All three occur in one 300-block sample.
 */
export function normalizeUri(uri: string, gateway = IPFS_GATEWAYS[0]): string | null {
  const v = uri.trim()
  if (!v) return null
  if (v.startsWith('http://') || v.startsWith('https://')) return v
  if (v.startsWith('ipfs://')) return gateway + v.slice('ipfs://'.length)
  // A bare CID. v0 starts Qm…, v1 starts b… — both are safe to hand to a gateway.
  if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})/.test(v)) return gateway + v
  return null
}

type Cached = TokenMeta & { at: number }

function readCache(): Record<string, Cached> {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') as Record<string, Cached>
  } catch {
    return {}
  }
}

function writeCache(address: string, meta: TokenMeta) {
  try {
    const all = readCache()
    all[address.toLowerCase()] = { ...meta, at: Date.now() }
    localStorage.setItem(CACHE_KEY, JSON.stringify(all))
  } catch {
    /* quota or private mode — the lookup simply repeats next visit */
  }
}

/** A month: artwork effectively never changes, and the lookup costs ~16 RPC calls. */
const CACHE_TTL = 30 * 24 * 60 * 60 * 1000

/**
 * ⚠ A miss is cached far more briefly than a hit.
 *
 * A lookup returns nothing for two very different reasons: the token genuinely published no
 * artwork, or something went wrong — a rate-limited RPC, a dead gateway, a search that landed on
 * the wrong block. Caching that for a month means one bad minute leaves a token blank until
 * September, and no redeploy can fix it because the staleness lives in the visitor's browser.
 */
const MISS_TTL = 60 * 60 * 1000

/**
 * Finds the block whose timestamp first reaches `targetSec`.
 *
 * ## ⚠⚠ Why the bracket is grown instead of assumed
 *
 * The obvious version extrapolates from an assumed block time and bisects a fixed window around
 * the guess. That is what this used to do — 0.75s per block, ±5,000 — and it is **wrong in a way
 * that only shows up later**. Every second between the target and now multiplies the extrapolation
 * error, so once the drift exceeds the window the true block is outside it, the bisection converges
 * on the window's edge, and it returns a confidently wrong answer.
 *
 * It failed exactly that way: a token launched at block 114041052 resolved to 114048226, roughly
 * 7,000 blocks adrift, so the launch event was never in the scanned range and the token silently
 * rendered with no artwork. The same lookup had worked hours earlier, which is what makes this
 * class of bug nasty — it degrades with time rather than failing outright.
 *
 * So the estimate is only a starting point now. The bracket is doubled outwards until it genuinely
 * contains the target timestamp, and only then bisected. Costs a couple of extra probes and cannot
 * drift.
 */
async function blockAtTime(targetSec: number): Promise<bigint> {
  const head = await archiveClient.getBlockNumber()
  const headBlock = await archiveClient.getBlock({ blockNumber: head })
  if (Number(headBlock.timestamp) <= targetSec) return head

  const timeAt = async (n: bigint) => Number((await archiveClient.getBlock({ blockNumber: n })).timestamp)

  // A guess, deliberately treated as nothing more than one.
  const drift = Number(headBlock.timestamp) - targetSec
  const estimate = head > BigInt(Math.floor(drift / 0.75)) ? head - BigInt(Math.floor(drift / 0.75)) : 0n

  let lo = estimate
  let hi = estimate
  let span = 4_000n

  // Walk `lo` down until it is genuinely before the target.
  while (lo > 0n && (await timeAt(lo)) > targetSec) {
    hi = lo
    lo = lo > span ? lo - span : 0n
    span *= 2n
  }
  // And `hi` up until it is genuinely after it.
  span = 4_000n
  while (hi < head && (await timeAt(hi)) < targetSec) {
    lo = hi
    hi = hi + span > head ? head : hi + span
    span *= 2n
  }

  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if ((await timeAt(mid)) < targetSec) lo = mid + 1n
    else hi = mid
  }
  return lo
}

/**
 * Recovers a token's metadata URI from its launch event.
 *
 * `createdAtMs` is the pair creation time — without it there is nothing to search around, so the
 * caller must supply it (DexScreener's `pairCreatedAt`). Windows widen on a miss because the pair
 * can be created a few blocks after the launch itself.
 */
async function findLaunchUri(token: Address, createdAtMs: number): Promise<string | null> {
  const block = await blockAtTime(Math.floor(createdAtMs / 1000))

  for (const span of [12n, 60n, 250n]) {
    const logs = await archiveClient.getLogs({
      address: FLAP.portal as Address,
      fromBlock: block > span ? block - span : 0n,
      toBlock: block + span,
      // @ts-expect-error raw topic filter — the event has no ABI we can trust
      topics: [LAUNCH_TOPIC0],
    })
    for (const log of logs) {
      const ev = decodeLaunchLog({
        data: log.data as Hex,
        topics: log.topics,
        blockNumber: log.blockNumber ?? 0n,
        transactionHash: (log.transactionHash ?? '0x') as Hex,
      })
      if (ev && ev.token.toLowerCase() === token.toLowerCase()) return ev.cid || null
    }
  }
  return null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * Fetches a token's artwork and links.
 *
 * Never throws and never blocks the row: any failure — no archive node, a metadata host without
 * CORS, a dead gateway, a token that published nothing — resolves to `EMPTY`, and the card falls
 * back to its symbol monogram. A missing image is a cosmetic gap, not an error worth surfacing.
 */
export async function fetchTokenMeta(token: Address, createdAtMs: number | null): Promise<TokenMeta> {
  const key = token.toLowerCase()
  const cached = readCache()[key]
  if (cached) {
    const ttl = cached.imageUrl ? CACHE_TTL : MISS_TTL
    if (Date.now() - cached.at < ttl) {
      const { at: _at, ...meta } = cached
      return meta
    }
  }
  if (!createdAtMs) return EMPTY

  try {
    const uri = await findLaunchUri(token, createdAtMs)
    const url = uri ? normalizeUri(uri) : null
    if (!url) {
      writeCache(key, EMPTY)
      return EMPTY
    }

    const res = await fetch(url, { headers: { accept: 'application/json' } })
    if (!res.ok) return EMPTY
    const doc = (await res.json()) as Record<string, unknown>

    // The image is itself a URI of any of the three shapes, so it needs the same normalisation.
    const rawImage = str(doc.image) ?? str(doc.image_url) ?? str(doc.imageUrl)
    const meta: TokenMeta = {
      imageUrl: rawImage ? normalizeUri(rawImage) : null,
      description: str(doc.description),
      twitter: str(doc.twitter),
      telegram: str(doc.telegram),
      website: str(doc.website),
    }
    writeCache(key, meta)
    return meta
  } catch {
    // Includes the CORS rejection thrown for metadata hosts that send no headers.
    return EMPTY
  }
}
