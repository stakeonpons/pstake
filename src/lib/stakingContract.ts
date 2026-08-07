/**
 * The staking contract, from the browser's side.
 *
 * Reads pool and position state, and builds the three transactions a staker sends: approve, stake,
 * and then claim or withdraw.
 *
 * ## The address comes from the environment
 *
 * `VITE_STAKING_ADDRESS`. Unset, every read here returns empty rather than throwing, so the pages
 * render their zero states instead of breaking. That is the same behaviour as a pool nobody has
 * staked in yet, which is exactly what those pages should show.
 *
 * ## ⚠ Staking is two transactions, and the first one is easy to forget
 *
 * ERC20 tokens have to be approved before the contract can pull them, so `stake` on its own reverts
 * for a fresh wallet. `ensureAllowance` handles that, and the caller must wait for the approval to
 * confirm before sending the stake, or the second transaction races the first.
 */

import { erc20Abi, parseAbi, type Address } from 'viem'
import { publicClient } from './chain'
import { STOCKS } from './stocks'

const ADDRESS = (import.meta.env.VITE_STAKING_ADDRESS as string | undefined) ?? ''

/** Null when no contract is configured. Callers treat that as "nothing staked". */
export function stakingAddress(): Address | null {
  return /^0x[0-9a-fA-F]{40}$/.test(ADDRESS) ? (ADDRESS as Address) : null
}

// prettier-ignore
export const STAKING_ABI = parseAbi([
  'function poolCount() view returns (uint256)',
  'function pools(uint256 poolId) view returns (address stakeToken, address rewardToken, uint256 totalStaked, uint256 totalWeight, uint256 queued, uint256 minStake)',
  'function positionCount(uint256 poolId, address user) view returns (uint256)',
  'function positions(uint256 poolId, address user, uint256 positionId) view returns (uint256 amount, uint256 weight, uint64 unlockAt, uint32 tierDays, bool withdrawn, uint256 pending)',
  'function pending(uint256 poolId, address user, uint256 positionId) view returns (uint256)',
  'function stakingOpen() view returns (bool)',
  'function harvestable(address rewardToken) view returns (uint256)',
  'function stake(uint256 poolId, uint256 amount, uint32 termDays) returns (uint256)',
  'function claim(uint256 poolId, uint256 positionId) returns (uint256)',
  'function withdraw(uint256 poolId, uint256 positionId) returns (uint256, uint256)',
])

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export type Pool = {
  id: number
  stakeToken: Address
  rewardToken: Address
  totalStaked: bigint
  totalWeight: bigint
  /**
   * The smallest position this pool accepts, in stake-token units.
   *
   * ⚠⚠ Not decoration. `stake` reverts `BelowMinimum` under it, and the floor is a whole unit of
   * the asset — one NVDA, one SPY — so a staker entering a fraction is the ordinary case, not an
   * odd one. It has to be shown and checked here, or the page takes an approval and then fails the
   * transaction it was for.
   */
  minStake: bigint
}

export type Position = {
  poolId: number
  id: number
  amount: bigint
  weight: bigint
  unlockAt: number
  tierDays: number
  withdrawn: boolean
  pending: bigint
}

/** Every pool, or an empty list when no contract is configured. */
export async function readPools(): Promise<Pool[]> {
  const address = stakingAddress()
  if (!address) return []
  try {
    const count = await publicClient.readContract({ address, abi: STAKING_ABI, functionName: 'poolCount' })
    const ids = Array.from({ length: Number(count) }, (_, i) => i)
    const rows = await Promise.all(
      ids.map((id) =>
        publicClient.readContract({ address, abi: STAKING_ABI, functionName: 'pools', args: [BigInt(id)] }),
      ),
    )
    return rows.map((r, i) => ({
      id: ids[i],
      stakeToken: r[0],
      rewardToken: r[1],
      totalStaked: r[2],
      totalWeight: r[3],
      minStake: r[5],
    }))
  } catch {
    return []
  }
}

/**
 * Whether the contract is currently accepting stakes.
 *
 * ⚠ Null means "no answer" — no contract configured, or the read failed — and is deliberately
 * distinct from `false`. A deployed contract starts CLOSED on purpose so its pools can be checked
 * on chain before anybody's money is in them, and a page that cannot tell the two apart either
 * hides staking that works or offers staking that reverts.
 */
export async function readStakingOpen(): Promise<boolean | null> {
  const address = stakingAddress()
  if (!address) return null
  try {
    return await publicClient.readContract({ address, abi: STAKING_ABI, functionName: 'stakingOpen' })
  } catch {
    return null
  }
}

/**
 * Every open position a wallet holds, across every pool.
 *
 * Withdrawn positions are dropped: they are history, and showing a closed lock alongside live ones
 * reads as a position the user still has.
 */
export async function readPositions(user: Address, pools: Pool[]): Promise<Position[]> {
  const address = stakingAddress()
  if (!address || !pools.length) return []
  try {
    const counts = await Promise.all(
      pools.map((p) =>
        publicClient.readContract({
          address,
          abi: STAKING_ABI,
          functionName: 'positionCount',
          args: [BigInt(p.id), user],
        }),
      ),
    )

    const wanted: { poolId: number; id: number }[] = []
    counts.forEach((n, i) => {
      for (let j = 0; j < Number(n); j++) wanted.push({ poolId: pools[i].id, id: j })
    })
    if (!wanted.length) return []

    const rows = await Promise.all(
      wanted.map((w) =>
        publicClient.readContract({
          address,
          abi: STAKING_ABI,
          functionName: 'positions',
          args: [BigInt(w.poolId), user, BigInt(w.id)],
        }),
      ),
    )

    return rows
      .map((r, i) => ({
        poolId: wanted[i].poolId,
        id: wanted[i].id,
        amount: r[0],
        weight: r[1],
        unlockAt: Number(r[2]),
        tierDays: Number(r[3]),
        withdrawn: r[4],
        pending: r[5],
      }))
      .filter((p) => !p.withdrawn)
  } catch {
    return []
  }
}

/**
 * What a harvest of each asset would pay out to stakers right now, keyed by lowercased address.
 *
 * This is the escrow balance owed to the contract plus anything left over from the last split — the
 * money that is waiting for somebody to call `harvest`. It is a CLAIMABLE figure, not a lifetime
 * total: the contract keeps no cumulative "rewards distributed", and this chain's 2,000-block log
 * cap means one cannot be reconstructed by scanning either. Nothing may label it as total or earned.
 */
export async function readHarvestable(assets: Address[]): Promise<Record<string, bigint>> {
  const address = stakingAddress()
  if (!address || !assets.length) return {}
  const out: Record<string, bigint> = {}
  await Promise.all(
    assets.map(async (asset) => {
      try {
        out[asset.toLowerCase()] = await publicClient.readContract({
          address,
          abi: STAKING_ABI,
          functionName: 'harvestable',
          args: [asset],
        })
      } catch {
        /* absent rather than zero: an unread asset is not the same as an empty one */
      }
    }),
  )
  return out
}

export type AssetMeta = { symbol: string; decimals: number }

/**
 * Symbol and decimals for every asset a set of pools touches, keyed by lowercased address.
 *
 * ⚠⚠ Decimals are read, never assumed. USDG is **6** where the seven equities are 18, so a position
 * formatted against a hard-coded 18 misprints it by a factor of a trillion. The stock table already
 * carries the right value for the assets it lists; anything else — a launched token's own pool — is
 * read from the token.
 *
 * An asset that answers neither is simply absent from the map, and callers fall back to showing the
 * raw address rather than a number that might be wrong.
 */
export async function readPoolAssets(pools: Pool[]): Promise<Record<string, AssetMeta>> {
  const wanted = new Set<string>()
  for (const p of pools) {
    wanted.add(p.stakeToken.toLowerCase())
    wanted.add(p.rewardToken.toLowerCase())
  }

  const out: Record<string, AssetMeta> = {}
  const unknown: Address[] = []
  for (const addr of wanted) {
    const stock = STOCKS.find((s) => s.address?.toLowerCase() === addr)
    if (stock) out[addr] = { symbol: stock.ticker, decimals: stock.decimals }
    else unknown.push(addr as Address)
  }

  await Promise.all(
    unknown.map(async (address) => {
      try {
        const [symbol, decimals] = await Promise.all([
          publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
          publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
        ])
        out[address.toLowerCase()] = { symbol, decimals }
      } catch {
        /* left out of the map on purpose; see the header */
      }
    }),
  )

  return out
}

/** The pool that takes a given asset, or null when there is none. */
export function poolFor(pools: Pool[], stakeToken: string): Pool | null {
  return pools.find((p) => p.stakeToken.toLowerCase() === stakeToken.toLowerCase()) ?? null
}

/* ------------------------------- transactions ------------------------------- */

type Provider = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }

const send = async (provider: Provider, from: string, to: string, data: string) =>
  (await provider.request({ method: 'eth_sendTransaction', params: [{ from, to, data }] })) as `0x${string}`

/**
 * Approves the staking contract to pull `amount`, if it cannot already.
 *
 * Returns the approval's hash, or null when the existing allowance is enough. ⚠ The caller must
 * wait for it to confirm before staking: the stake pulls the tokens, so an unconfirmed approval
 * means the stake reverts.
 */
export async function ensureAllowance(
  args: { token: Address; owner: Address; amount: bigint },
  provider: Provider,
): Promise<`0x${string}` | null> {
  const spender = stakingAddress()
  if (!spender) throw new Error('Staking is unavailable right now.')

  const current = await publicClient.readContract({
    address: args.token,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [args.owner, spender],
  })
  if (current >= args.amount) return null

  const { encodeFunctionData } = await import('viem')
  return send(
    provider,
    args.owner,
    args.token,
    encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, args.amount] }),
  )
}

export async function sendStake(
  args: { poolId: number; amount: bigint; termDays: number; from: Address },
  provider: Provider,
): Promise<`0x${string}`> {
  const to = stakingAddress()
  if (!to) throw new Error('Staking is unavailable right now.')
  const { encodeFunctionData } = await import('viem')
  return send(
    provider,
    args.from,
    to,
    encodeFunctionData({
      abi: STAKING_ABI,
      functionName: 'stake',
      args: [BigInt(args.poolId), args.amount, args.termDays],
    }),
  )
}

export async function sendClaim(
  args: { poolId: number; positionId: number; from: Address },
  provider: Provider,
): Promise<`0x${string}`> {
  const to = stakingAddress()
  if (!to) throw new Error('Staking is unavailable right now.')
  const { encodeFunctionData } = await import('viem')
  return send(
    provider,
    args.from,
    to,
    encodeFunctionData({
      abi: STAKING_ABI,
      functionName: 'claim',
      args: [BigInt(args.poolId), BigInt(args.positionId)],
    }),
  )
}

export async function sendWithdraw(
  args: { poolId: number; positionId: number; from: Address },
  provider: Provider,
): Promise<`0x${string}`> {
  const to = stakingAddress()
  if (!to) throw new Error('Staking is unavailable right now.')
  const { encodeFunctionData } = await import('viem')
  return send(
    provider,
    args.from,
    to,
    encodeFunctionData({
      abi: STAKING_ABI,
      functionName: 'withdraw',
      args: [BigInt(args.poolId), BigInt(args.positionId)],
    }),
  )
}
