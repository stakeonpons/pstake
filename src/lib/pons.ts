/**
 * Pons — the launchpad Stake builds on, on Robinhood Chain.
 *
 * ## ⚠⚠ There are TWO live Pons generations and they are not compatible
 *
 * | Factory | Pairs against | Launches |
 * | --- | --- | --- |
 * | `0xA5aAb3F0…1feB` (V1) | **WETH only** | open |
 * | `0x7E1EAbd5…4dB8` (V2) | an **approved tokenized stock**, chosen per launch | `launchEnabled = false` |
 *
 * **Stake targets V2 and only V2.** The entire product is "a token paired against a stock, whose
 * trading fees pay that stock's stakers", and V1 cannot express it — every V1 token is paired
 * against WETH, so there would be no stock to pay anyone in. Pointing this file at V1 to make the
 * Launch button work would quietly ship a different product.
 *
 * ⚠ V2 launches are switched off at the factory as of 5 Aug 2026. That is Pons's setting, not
 * ours: `launchEnabled()` is read live (see `readLaunchGate`) and the Launch page follows it, so
 * the day Pons turns it on the launcher works with no code change.
 */

import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { publicClient } from './chain'
import { STOCKS } from './stocks'

/**
 * ⚠⚠ Takes the VALUE, not the name — and that is a security property, not a style choice.
 *
 * This used to do `import.meta.env[name]` with a dynamic key. Vite can only substitute
 * `import.meta.env.SOMETHING` when the key is a literal it can see at build time; given a dynamic
 * one it gives up and inlines the **entire env object**, so every `VITE_*` variable ends up in the
 * public bundle — including ones no code reads.
 *
 * That is exactly what happened: a keyed RPC endpoint left over from an earlier build was sitting
 * unused in `.env.local` and shipped to every visitor. Pass `import.meta.env.VITE_WHATEVER` in at
 * the call site so the access stays static and only that one variable is inlined.
 */
function requireEnv(name: string, v: string | undefined): string {
  if (!v) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in — a launch encoded ` +
        `without it would route creator fees nowhere.`,
    )
  }
  return v
}

export const PONS = {
  /** PonsV2LaunchFactory. Verified source on Blockscout. */
  factory: '0x7E1EAbd52Ae29598e6483F72dCf1a70b14284dB8',
  /**
   * ⛔ The V1 factory. Recorded so nobody rediscovers it and wires it in by mistake — it answers
   * `exists=false` for every V2 token and pairs only against WETH.
   */
  v1Factory: '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  /** Uniswap V4 singleton. There is no pair contract on V2; price comes from the pool's slot0. */
  poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  hook: '0x8e99D2009D60A917e9B1c00C04C077b8c0c3a044',
  locker: '0x28b6F0116c7F234951cf0e67319ed53863Df2197',
  weth: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
} as const

/** The real Pons app. ⚠⚠ `pons.money` is NOT pons — it trips wallet phishing blocklists. */
export const PONS_APP = 'https://www.ponsfamily.com/launchpad'

export function ponsTokenUrl(address: string): string {
  return `${PONS_APP}/${address}`
}

/**
 * Launch fee, in wei of the chain's native asset. Read live rather than hard-coded, because Pons
 * can change it with `setLaunchFee` and a stale value makes every launch revert.
 */
export const FALLBACK_LAUNCH_FEE_WEI = 500_000_000_000_000n

/**
 * What creator fees do on Pons.
 *
 * ⭐ Unlike flap, **fees are claimable by the recipient itself**, which is what makes trustless
 * routing into a staking contract possible here and awkward on flap.
 *
 * ⚠⚠ V2 does NOT use the locker for this. `PonsLaunchLocker.collectFees` belongs to the **V1**
 * generation; the V2 locker holds only the LP position. V2 credits a **fee escrow** keyed by
 * (recipient, asset) — see `FEE_ESCROW` in `fees.ts`, found via `factory.feeEscrow()`.
 */
export const FEE_MODEL = {
  pushed: false,
  /** The escrow credits a claimable balance; claiming it zeroes it. It is not a lifetime total. */
  claimableNotCumulative: true,
} as const

/**
 * Social links a creator can attach.
 *
 * ⭐ These are **on-chain strings** in the launch parameters, along with the logo and description.
 * Nothing is pinned to IPFS and nothing is looked up from a launch event afterwards — the token's
 * own metadata is readable from the chain forever. flap needed a pinning service and an archive
 * node for the same job.
 */
export type LaunchLinks = {
  twitter: string
  telegram: string
  discord: string
  website: string
  farcaster: string
}

export const EMPTY_LINKS: LaunchLinks = {
  twitter: '',
  telegram: '',
  discord: '',
  website: '',
  farcaster: '',
}

export type LaunchParams = {
  name: string
  symbol: string
  description: string
  /** Image URL or IPFS URI, stored on chain as a plain string. */
  logo: string
  /** stock ticker this token is paired against — decides the payout stock. */
  quoteAsset: string
  /** That stock's contract address. The factory pairs by address, not ticker. */
  quoteTokenAddress: string
  links: LaunchLinks
}

export type LaunchTx = { to: string; data: string; value: bigint }

/**
 * Launch terms fixed for every token launched through Stake.
 *
 * Policy, not preferences: not surfaced in the UI, not derived from form state, and a creator
 * cannot vary them. Everything that encodes a launch reads them from here.
 */
export const LAUNCH_POLICY = {
  /**
   * Where creator fees go.
   *
   * Read from the environment so it is not committed to a public repository. It still reaches the
   * browser — the launch transaction carries it and that transaction is public — so this is about
   * source control, not secrecy.
   *
   * ⚠ Deliberately not defaulted; see `requireEnv`.
   */
  creatorFeeRecipient: requireEnv('VITE_FEE_RECIPIENT', import.meta.env.VITE_FEE_RECIPIENT),

  /**
   * Creator tax, in basis points. 200 = 2%, matching what the product charged on pons.
   *
   * ⚠ This is a genuinely different mechanism from flap's buy/sell tax even though the rate is the
   * same: Pons takes it through the curve and the pool hook rather than on transfer, and there is
   * one rate, not a separate buy and sell figure.
   */
  creatorTaxBps: 200,

  /** Pons's buyback-and-burn mode. Off: fees are for stakers, not for burning supply. */
  buybackEnabled: false,

  /** The only launch config V2 exposes. Read `launchConfigCount()` before assuming a second. */
  launchConfigId: 0n,
} as const

export type ResolvedLaunch = LaunchParams & typeof LAUNCH_POLICY

export function resolveLaunch(params: LaunchParams): ResolvedLaunch {
  return {
    ...params,
    // Policy last, so nothing a creator typed can override it.
    ...LAUNCH_POLICY,
  }
}

/* ------------------------------- the launch call ------------------------------- */

// ⚠ One unbroken string literal on purpose. `parseAbi` infers its types from the literal, and
// splitting it across concatenated lines collapses the inferred ABI to `never`.
// prettier-ignore
export const FACTORY_ABI = parseAbi([
  'function launchToken((string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics) params,uint256 launchConfigId,address pairToken) payable returns (address token,address curve)',
  'function launchEnabled() view returns (bool)',
  'function launchFee() view returns (uint256)',
  'function launchConfigCount() view returns (uint256)',
  'function approvedPairTokens(address) view returns (bool)',
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists) info)',
  'function getLaunchFeePolicy(address token) view returns ((address protocolFeeRecipient,uint16 protocolFeeShareBps,uint16 buybackBurnBps,uint16 hookFeeBps,uint16 maxInternalPriceImpactBps) policy)',
])

/**
 * ⚠⚠ **`expectedEconomics` is the one field in this encoder that has not been proven against a
 * real launch.** It reads as a commitment to the fee policy in force when the creator signed —
 * i.e. protection against Pons changing the terms between signing and mining — and zero is the
 * "no expectation" value that such a check normally accepts.
 *
 * Zero is used here, and it must be confirmed by decoding a real V2 launch before the first live
 * launch. That is not urgent while `launchEnabled()` is false and the button cannot fire, and it is
 * why `buildLaunch` is never reachable from a UI that has not checked the gate.
 */
export const EXPECTED_ECONOMICS_ANY: Hex = `0x${'0'.repeat(64)}`

/** Builds the launch transaction. The creator's own wallet signs and pays it. */
export function buildLaunch(params: LaunchParams, launchFeeWei: bigint): LaunchTx {
  const p = resolveLaunch(params)

  const stock = STOCKS.find((s) => s.address.toLowerCase() === p.quoteTokenAddress.toLowerCase())
  if (!stock) {
    throw new Error(
      `${p.quoteAsset} is not an approved Pons pair token. A launch against it would revert.`,
    )
  }

  const data = encodeFunctionData({
    abi: FACTORY_ABI,
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
        // ⚠ Policy, never a form value. This is what makes the token pay Stake's stakers.
        creatorFeeRecipient: p.creatorFeeRecipient as Address,
        creatorTaxBps: p.creatorTaxBps,
        buybackEnabled: p.buybackEnabled,
        expectedEconomics: EXPECTED_ECONOMICS_ANY,
      },
      p.launchConfigId,
      p.quoteTokenAddress as Address,
    ],
  })

  return { to: PONS.factory, data, value: launchFeeWei }
}

/* ------------------------------- live gates ------------------------------- */

export type LaunchGate = {
  /** Pons's own switch. False today; the Launch page must follow it rather than assume. */
  enabled: boolean
  /** Fee in wei, read live — `setLaunchFee` can change it and a stale value reverts every launch. */
  feeWei: bigint
}

/**
 * Reads whether Pons is accepting launches, and at what fee.
 *
 * ⚠ Never cache this across a session. It is the difference between a button that submits a
 * transaction the chain will reject and a button that is honestly closed.
 */
export async function readLaunchGate(): Promise<LaunchGate> {
  const [enabled, feeWei] = await Promise.all([
    publicClient
      .readContract({ address: PONS.factory as Address, abi: FACTORY_ABI, functionName: 'launchEnabled' })
      .catch(() => false),
    publicClient
      .readContract({ address: PONS.factory as Address, abi: FACTORY_ABI, functionName: 'launchFee' })
      .catch(() => FALLBACK_LAUNCH_FEE_WEI),
  ])
  return { enabled: Boolean(enabled), feeWei: feeWei as bigint }
}

/** Sends the launch from the creator's own wallet. Non-custodial: Stake never holds keys. */
export async function sendLaunch(
  provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
  args: { owner: Address; params: LaunchParams; launchFeeWei: bigint },
): Promise<Hex> {
  const tx = buildLaunch(args.params, args.launchFeeWei)
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: args.owner, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }],
  })
  return hash as Hex
}

/* ------------------------------- the developer buy ------------------------------- */

/**
 * The creator's own first buy, as a SEPARATE pair of transactions after the launch.
 *
 * ⚠⚠ **Pons V2 cannot do this at launch time, and it is not an oversight to work around.** The
 * verified `PonsV2LaunchFactory` ABI was read directly: `launchToken`'s params struct is
 * name/symbol/logo/description/socials/creatorFeeRecipient/creatorTaxBps/buybackEnabled/
 * expectedEconomics — **no buy amount** — and `launchToken` is the factory's ONLY payable function,
 * carrying the launch fee alone. Corroborated against reality: all **16** real V2 launches report
 * `initialBuyWei: 0`, while V1 launches (which pair against native) carry real amounts.
 *
 * So the buy happens on the bonding curve that `launchToken` returns:
 *
 *   `buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)`
 *
 * ⚠⚠ **`isNativeQuote()` is FALSE for every stock-paired curve** (read live off a real one). The
 * quote is the tokenized stock, an ERC-20, so the buy needs an **approve first** and `msg.value`
 * must be **zero**. Sending value here would be a plain loss. ⚠ The accessor is `pairToken()`, not
 * `quoteToken()` — the latter reverts.
 *
 * ⚠⚠ **`quoteIn` is in the PAIR TOKEN's own decimals.** The seven equities are 18 and **USDG is 6**,
 * so a hard-coded 1e18 would ask for a trillion USDG. Callers must pass an amount already parsed
 * with that token's `decimals()`.
 */
export const CURVE_ABI = parseAbi([
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function token() view returns (address)',
])

export const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
])

/**
 * Slippage floor applied to the simulated output.
 *
 * ⭐ The expected output is not re-derived from the curve's reserves — that means reimplementing
 * Pons's bonding-curve maths and being wrong with the creator's money. It is SIMULATED against the
 * deployed curve instead (`eth_call` on `buy`, which returns `tokensOut`), and this floor is applied
 * to the answer the chain itself gave.
 *
 * ⛔ Never send `minTokensOut: 0`. The launch and the buy are separate transactions, so anyone can
 * act in between; a zero floor accepts any output at all, including a sandwiched one.
 */
export const DEV_BUY_SLIPPAGE_BPS = 200n

export function applySlippage(expected: bigint): bigint {
  return (expected * (10_000n - DEV_BUY_SLIPPAGE_BPS)) / 10_000n
}

/** Reads the curve address for a token straight from the factory. */
export async function readCurveFor(token: Address): Promise<Address | null> {
  try {
    const info = (await publicClient.readContract({
      address: PONS.factory as Address,
      abi: FACTORY_ABI,
      functionName: 'getLaunchedToken',
      args: [token],
    })) as { curve: Address; exists: boolean }
    return info?.exists ? info.curve : null
  } catch {
    return null
  }
}

type Eip1193 = { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }

/** Approves the curve to pull `amount` of the pair token. Returns the transaction hash. */
export async function sendApprove(
  provider: Eip1193,
  args: { owner: Address; pairToken: Address; curve: Address; amount: bigint },
): Promise<Hex> {
  const data = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: 'approve',
    args: [args.curve, args.amount],
  })
  return (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: args.owner, to: args.pairToken, data }],
  })) as Hex
}

/**
 * Buys on the curve with the pair token.
 *
 * ⚠ No `value` field: the quote is an ERC-20 and the curve pulls it through the allowance. Sending
 * native here would strand it.
 */
export async function sendDevBuy(
  provider: Eip1193,
  args: { owner: Address; curve: Address; quoteIn: bigint; minTokensOut: bigint },
): Promise<Hex> {
  const data = encodeFunctionData({
    abi: CURVE_ABI,
    functionName: 'buy',
    args: [args.quoteIn, args.minTokensOut, args.owner],
  })
  return (await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: args.owner, to: args.curve, data }],
  })) as Hex
}

/**
 * Asks the deployed curve what a given spend would return, so the slippage floor is anchored to the
 * chain rather than to maths reimplemented here.
 *
 * ⚠ Must be called with the allowance already in place — the curve pulls the quote during the call,
 * so simulating before approving reverts for a reason that has nothing to do with the price.
 * Returns null when it cannot be simulated; the caller must then refuse rather than guess a floor.
 */
export async function previewDevBuy(args: {
  owner: Address
  curve: Address
  quoteIn: bigint
}): Promise<bigint | null> {
  try {
    const { result } = await publicClient.simulateContract({
      address: args.curve,
      abi: CURVE_ABI,
      functionName: 'buy',
      args: [args.quoteIn, 0n, args.owner],
      account: args.owner,
    })
    return result as bigint
  } catch {
    return null
  }
}

/** Client-side validation shared by the form and the submit handler. */
export function validateLaunch(p: {
  name: string
  symbol: string
  quoteTokenAddress: string
}): string | null {
  if (!p.name.trim()) return 'Name is required'
  if (!p.symbol.trim()) return 'Symbol is required'
  if (p.symbol.length > 16) return 'Symbol is too long'
  if (!p.quoteTokenAddress) return 'Choose a stock to pair against'
  if (!STOCKS.some((s) => s.address.toLowerCase() === p.quoteTokenAddress.toLowerCase())) {
    return 'That asset is not approved as a Pons pair token'
  }
  return null
}
