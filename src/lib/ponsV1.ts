/**
 * Pons **V1** — the generation Stake actually launches on.
 *
 * ## Why V1 and not V2
 *
 * V2 pairs a token against a tokenized stock, which is the shape this product describes, but Pons
 * keeps `launchEnabled = false` on it. V1 is open. So launches go through V1 and the stock a
 * creator picks is recorded by **us**, off chain, rather than being the on-chain pair.
 *
 * ## ⚠⚠ V1 pairs against WETH. Always. There is no stock-paired V1.
 *
 * `launchToken` takes **no pair token**: the pair comes from `launchConfigId`, and the factory has
 * exactly **ONE** launch config (`launchConfigCount() == 1`) whose `pairToken` is **WETH**
 * (`0x0Bd7D308…AD73`). Verified live. One dex config, likewise.
 *
 * ➤ The consequence that matters: **fees accrue in WETH and in the launched token, NOT in the
 * chosen stock.** A V2 stock-paired token earned fees already denominated in the stock, which is
 * what made paying stakers in it automatic. On V1 that conversion is an operational step, not a
 * property of the launch. The picked stock is a routing instruction we store, not a fact the chain
 * enforces — do not present it as though the chain guarantees it.
 *
 * ## ⭐ The fee wallet is a LAUNCH PARAMETER
 *
 * `params.feeWallet` is set in the launch call itself, so every token launched here names Stake's
 * wallet with no extra transaction and nothing for a creator to configure. It is deliberately not
 * rendered anywhere and not settable from the form.
 *
 * ⚠ It is not a secret — the launch transaction is public and `feeRedirects(token)` reads it back.
 * "Not visible in the UI" is the requirement; "unknowable" is not achievable and must not be
 * claimed.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { publicClient } from './chain'

/** PonsLaunchFactory (V1). Verified source on Blockscout. */
export const PONS_V1 = {
  factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB' as Address,
  /** PonsLaunchLocker — where V1 fee routing and collection actually live. */
  locker: '0x736D76699C26D0d966744cAe304C000d471f7F35' as Address,
  /** The only pair token V1 offers. */
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' as Address,
  /** The single enabled launch config and dex config. Read back before use, never assumed. */
  launchConfigId: 0n,
  dexId: 0n,
} as const

export const V1_FACTORY_ABI = parseAbi([
  'function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address feeWallet) params, uint256 launchConfigId, uint256 dexId, bytes32 salt) payable returns (address token)',
  'function launchEnabled() view returns (bool)',
  'function launchFee() view returns (uint256)',
  'function launchConfigCount() view returns (uint256)',
  'function getLaunchConfig(uint256 id) view returns (address pairToken, uint256 graduationThreshold, int24 initialTick, uint256 supply, uint16 maxWalletBps, uint16 maxTxBps, uint32 restrictionBlocks, uint24 reservedFee, bool enabled, bool routerRequiresDeadline)',
  'function getLaunchedToken(address token) view returns ((address token,address deployer,address pairedToken,address positionManager,uint256 positionId,uint256 dexId,uint256 launchConfigId,uint256 restrictionsEndBlock,uint256 supply,bool isToken0,uint24 poolFee,bool exists,uint256 initialBuyAmount) info)',
])

/**
 * ⚠ `collectFees` is `nonpayable`, so reading it means SIMULATING it. Two reverts are meaningful
 * and must be told apart:
 *   - `NoFeesToCollect()` — **zero, not a failure.** Surfacing this as an error would show every
 *     creator a broken page for the ordinary state of having nothing accrued yet.
 *   - `NotAuthorized()` — the caller is not the fee wallet or an approved collector. Simulating
 *     from the wrong `from` address produces this, which looks identical to "broken" if unhandled.
 */
export const LOCKER_ABI = parseAbi([
  'function collectFees(address token) returns (uint256 amount0, uint256 amount1)',
  'function feeRedirects(address token) view returns (address recipient)',
  'function feeRecipientTokenCount(address recipient) view returns (uint256)',
  'function feeRecipientTokens(address recipient, uint256 index) view returns (address token)',
  'function deployerTokenCount(address deployer) view returns (uint256)',
  'function deployerTokens(address deployer, uint256 index) view returns (address token)',
  'function protocolFeeShare() view returns (uint256)',
  'function tokenProtocolFeeShares(address token) view returns (uint256)',
  'error NoFeesToCollect()',
  'error NotAuthorized()',
])

export type V1Launch = {
  name: string
  symbol: string
  logo: string
  description: string
  links: { twitter: string; telegram: string; discord: string; website: string; farcaster: string }
  /** Stake's wallet. Never a form value. */
  feeWallet: Address
}

export type V1LaunchTx = { to: Address; data: Hex; value: bigint }

/**
 * Builds the V1 launch transaction.
 *
 * ⚠ `salt` must vary per launch. V1 deploys with CREATE2, so two launches with identical params and
 * the same salt would target the same address and the second would revert. A random salt avoids
 * that without needing to grind for a vanity address.
 */
/**
 * ⛔⛔ **The launch NEVER carries an initial buy. `value` is the launch fee, and nothing else.**
 *
 * V1 does support one — extra `msg.value` above the fee is recorded as `initialBuyAmount`, proven
 * by arithmetic on a real launch (`27340792939659113` − `500000000000000` = `26840792939659113`).
 * ⚠⚠ **But the purchased tokens are sent to `params.feeWallet`, NOT to the buyer.** Executed on a
 * fork to be sure: a 0.05 ETH initial buy put ~35.2M tokens in the fee wallet and left the creator
 * with **zero**; the same launch with no initial buy put zero there.
 *
 * That is fine in Pons's own design, where `feeWallet` IS the creator. It is NOT fine here, where
 * the fee wallet is Stake's: a creator would spend their ETH and Stake would receive their tokens.
 * So the launch is always sent with `initialBuyAmount = 0` and a creator's buy is executed
 * separately as a snipe from their own wallet — see `buildSnipe`.
 */
export function buildV1Launch(p: V1Launch, launchFeeWei: bigint, salt: Hex): V1LaunchTx {
  const data = encodeFunctionData({
    abi: V1_FACTORY_ABI,
    functionName: 'launchToken',
    args: [
      {
        name: p.name,
        symbol: p.symbol,
        logo: p.logo,
        description: p.description,
        socials: {
          twitter: p.links.twitter,
          telegram: p.links.telegram,
          discord: p.links.discord,
          website: p.links.website,
          farcaster: p.links.farcaster,
        },
        feeWallet: p.feeWallet,
      },
      PONS_V1.launchConfigId,
      PONS_V1.dexId,
      salt,
    ],
  })
  return { to: PONS_V1.factory, data, value: launchFeeWei }
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}` as Hex
}

export type V1Gate = { enabled: boolean; feeWei: bigint }

/** Reads V1's own gate and fee. Live on every use — `setLaunchFee` exists and a stale fee reverts. */
export async function readV1Gate(): Promise<V1Gate> {
  const [enabled, feeWei] = await Promise.all([
    publicClient.readContract({ address: PONS_V1.factory, abi: V1_FACTORY_ABI, functionName: 'launchEnabled' }),
    publicClient.readContract({ address: PONS_V1.factory, abi: V1_FACTORY_ABI, functionName: 'launchFee' }),
  ])
  return { enabled: Boolean(enabled), feeWei: feeWei as bigint }
}

/** Sends the launch from the creator's own wallet. Non-custodial: Stake never holds keys. */
export async function sendV1Launch(
  provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
  args: { owner: Address; params: V1Launch; launchFeeWei: bigint },
): Promise<Hex> {
  const tx = buildV1Launch(args.params, args.launchFeeWei, randomSalt())
  return (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: args.owner, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }],
  })) as Hex
}

/* ------------------------------------ fees ------------------------------------ */

export type V1Fees = {
  /** Uncollected fees denominated in the launched token itself. */
  token: bigint
  /** Uncollected fees denominated in ETH (the WETH the pool pairs against). */
  eth: bigint
  /** True when the position holds nothing to collect — a normal state, not an error. */
  empty: boolean
}

/**
 * Reads what `collectFees(token)` would pay right now, by simulating it as the fee wallet.
 *
 * ⛔ There is no view function for this. Simulation is the only way, and it must be run `from` the
 * fee wallet or the locker answers `NotAuthorized()`.
 *
 * Returns zeros for `NoFeesToCollect()` and **null** for anything else, so a genuine fault is never
 * silently rendered as "no fees earned".
 */
export async function readV1Fees(token: Address, feeWallet: Address): Promise<V1Fees | null> {
  try {
    const { result } = await publicClient.simulateContract({
      address: PONS_V1.locker,
      abi: LOCKER_ABI,
      functionName: 'collectFees',
      args: [token],
      account: feeWallet,
    })
    const [amount0, amount1] = result as unknown as [bigint, bigint]

    /*
      ⚠⚠ `amount0`/`amount1` are the POOL's ordering, which is by address, not by role. Labelling
      them by assumption would swap the token and ETH figures for every token that happens to sort
      the other way. The factory records which one this token is, so the mapping is read, not
      guessed.
    */
    const isToken0 = await publicClient
      .readContract({
        address: PONS_V1.factory,
        abi: V1_FACTORY_ABI,
        functionName: 'getLaunchedToken',
        args: [token],
      })
      .then((i) => (i as { isToken0: boolean }).isToken0)
      .catch(() => null)
    if (isToken0 === null) return null

    return {
      token: isToken0 ? amount0 : amount1,
      eth: isToken0 ? amount1 : amount0,
      empty: amount0 === 0n && amount1 === 0n,
    }
  } catch (err) {
    if (String((err as Error)?.message ?? '').includes('NoFeesToCollect')) {
      return { token: 0n, eth: 0n, empty: true }
    }
    return null
  }
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/**
 * The wallet V1 fees for this token actually reach.
 *
 * ⚠⚠ **`feeRedirects` is an OVERRIDE, not the destination.** It is the zero address unless somebody
 * has explicitly redirected the token, and the default is the **deployer**. Reading only
 * `feeRedirects` therefore reports "no fee wallet" for every token that never set one — which is
 * most of them, including a token whose launcher already IS the intended recipient.
 *
 * ✅ Confirmed against the live STAKE token: `feeRedirects` is zero, yet simulating `collectFees`
 * as the deployer returns real amounts while any other caller is refused `NotAuthorized`.
 */
export async function readV1FeeWallet(token: Address): Promise<Address | null> {
  try {
    const redirect = (await publicClient.readContract({
      address: PONS_V1.locker,
      abi: LOCKER_ABI,
      functionName: 'feeRedirects',
      args: [token],
    })) as Address
    if (redirect && redirect.toLowerCase() !== ZERO_ADDRESS) return redirect

    // No override, so the fees belong to whoever launched it.
    const info = (await publicClient.readContract({
      address: PONS_V1.factory,
      abi: V1_FACTORY_ABI,
      functionName: 'getLaunchedToken',
      args: [token],
    })) as { deployer: Address; exists: boolean }
    return info?.exists ? info.deployer : null
  } catch {
    return null
  }
}

/**
 * Every V1 token whose fees reach `recipient`, from the locker's own indexes. No server, no log
 * scan — which matters because the RPC caps `eth_getLogs` at 2,000 blocks (~3 minutes) here.
 *
 * ⚠⚠ **TWO indexes, and neither alone is enough.**
 *  - `feeRecipientTokens` covers tokens explicitly REDIRECTED to us — what a launch through this
 *    site produces, because it names a fee wallet that differs from the creator.
 *  - `deployerTokens` covers tokens WE launched, where `feeRedirects` stays the zero address
 *    because the default recipient is already the deployer.
 *
 * Reading only the first silently omits every token the operator launched themselves; reading only
 * the second omits every token launched by a creator through the site.
 *
 * ⭐ The union is then filtered by the EFFECTIVE fee wallet, so a token that was deployed by us and
 * later redirected elsewhere drops out rather than being listed as ours on the strength of history.
 */
async function readIndex(
  fn: 'feeRecipientTokens' | 'deployerTokens',
  countFn: 'feeRecipientTokenCount' | 'deployerTokenCount',
  who: Address,
): Promise<Address[]> {
  try {
    const n = (await publicClient.readContract({
      address: PONS_V1.locker,
      abi: LOCKER_ABI,
      functionName: countFn,
      args: [who],
    })) as bigint
    if (n === 0n) return []
    const out = await Promise.all(
      Array.from({ length: Number(n) }, (_, i) =>
        publicClient
          .readContract({ address: PONS_V1.locker, abi: LOCKER_ABI, functionName: fn, args: [who, BigInt(i)] })
          .catch(() => null),
      ),
    )
    return out.filter(Boolean) as Address[]
  } catch {
    return []
  }
}

export async function listV1TokensFor(recipient: Address): Promise<Address[]> {
  const [redirected, deployed] = await Promise.all([
    readIndex('feeRecipientTokens', 'feeRecipientTokenCount', recipient),
    readIndex('deployerTokens', 'deployerTokenCount', recipient),
  ])

  const seen = new Set<string>()
  const candidates: Address[] = []
  for (const a of [...redirected, ...deployed]) {
    const k = a.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    candidates.push(a)
  }

  const resolved = await Promise.all(
    candidates.map(async (a) => ((await readV1FeeWallet(a))?.toLowerCase() === recipient.toLowerCase() ? a : null)),
  )
  return resolved.filter(Boolean) as Address[]
}

/* ------------------------------------ the snipe ------------------------------------ */

/**
 * The creator's own first buy, executed as a swap from THEIR wallet immediately after the launch.
 *
 * ⭐ This exists because V1's built-in initial buy pays the wrong person here — it credits
 * `params.feeWallet`, which on this site is Stake, not the creator. Buying on the pool instead
 * means the ETH and the tokens both belong to the same wallet, which is the only arrangement that
 * is not simply taking a creator's money.
 *
 * ⚠ SwapRouter02, so `exactInputSingle` has **no deadline field** (that is the SwapRouter01 shape).
 * The router accepts native ETH directly when `tokenIn` is its own WETH9, which is verified to be
 * the same WETH V1 pairs against — so no wrap and no approve is needed.
 */
export const V1_DEX = {
  swapRouter: '0xCaf681a66D020601342297493863E78C959E5cb2' as Address,
  /** Read back per token from the launch record rather than assumed; this is the config default. */
  poolFee: 10000,
} as const

export const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function WETH9() view returns (address)',
])

/** The pool fee this token was actually launched with. Falls back to the config default. */
export async function readPoolFee(token: Address): Promise<number> {
  try {
    const info = (await publicClient.readContract({
      address: PONS_V1.factory,
      abi: V1_FACTORY_ABI,
      functionName: 'getLaunchedToken',
      args: [token],
    })) as { poolFee: number; exists: boolean }
    return info?.exists && info.poolFee ? Number(info.poolFee) : V1_DEX.poolFee
  } catch {
    return V1_DEX.poolFee
  }
}

/**
 * Asks the router what a spend would return, so the slippage floor comes from the chain rather than
 * from bonding-curve maths reimplemented here. Returns null when it cannot be simulated.
 */
export async function previewSnipe(args: {
  owner: Address
  token: Address
  amountWei: bigint
  poolFee: number
}): Promise<bigint | null> {
  try {
    const { result } = await publicClient.simulateContract({
      address: V1_DEX.swapRouter,
      abi: ROUTER_ABI,
      functionName: 'exactInputSingle',
      args: [
        {
          tokenIn: PONS_V1.weth,
          tokenOut: args.token,
          fee: args.poolFee,
          recipient: args.owner,
          amountIn: args.amountWei,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      account: args.owner,
      value: args.amountWei,
    })
    return result as bigint
  } catch {
    return null
  }
}

/** Sends the snipe. Native ETH in, tokens out, both belonging to the creator. */
export async function sendSnipe(
  provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
  args: { owner: Address; token: Address; amountWei: bigint; minOut: bigint; poolFee: number },
): Promise<Hex> {
  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: PONS_V1.weth,
        tokenOut: args.token,
        fee: args.poolFee,
        recipient: args.owner,
        amountIn: args.amountWei,
        amountOutMinimum: args.minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  return (await provider.request({
    method: 'eth_sendTransaction',
    params: [
      { from: args.owner, to: V1_DEX.swapRouter, data, value: `0x${args.amountWei.toString(16)}` },
    ],
  })) as Hex
}

/**
 * Waits until the launch's anti-snipe restriction window has passed.
 *
 * ⚠⚠ **Without this the snipe reverts with Uniswap's `TF`, and the size makes no difference.**
 * Proven on a fork: in the launch block, buys of both 0.01 and 0.05 ETH revert; one block past
 * `restrictionsEndBlock` the identical buys succeed (0.05 ETH → 3.52% of supply). The launch config
 * sets `restrictionBlocks = 2`, and the token refuses transfers until then, so the pool's payout
 * fails and Uniswap surfaces it as a transfer failure rather than anything about price.
 *
 * ⚠ It must also run BEFORE the preview: simulating inside the window fails for the same reason,
 * which would otherwise look like "the buy could not be simulated" and cancel a perfectly good buy.
 *
 * Robinhood Chain makes a block roughly every 100ms, so this is a fraction of a second in practice.
 */
export async function waitForTrading(token: Address, timeoutMs = 30_000): Promise<boolean> {
  let endBlock: bigint
  try {
    const info = (await publicClient.readContract({
      address: PONS_V1.factory,
      abi: V1_FACTORY_ABI,
      functionName: 'getLaunchedToken',
      args: [token],
    })) as { restrictionsEndBlock: bigint; exists: boolean }
    if (!info?.exists) return false
    endBlock = info.restrictionsEndBlock
  } catch {
    return false
  }

  const deadline = Date.now() + timeoutMs
  for (;;) {
    const now = await publicClient.getBlockNumber().catch(() => null)
    if (now !== null && now > endBlock) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, 400))
  }
}
