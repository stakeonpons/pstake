/**
 * flap.sh launch integration for bStake.
 *
 * ## The encoder is live, and every claim here was checked against the chain
 *
 * Launching goes through the Portal's `newTokenV6`. The struct is published in flap's docs, but
 * documentation was not treated as sufficient — each of these was verified directly, 5 Aug 2026:
 *
 *  - The documented struct hashes to selector **`0x8cb5772c`**, which is exactly the 1152-byte
 *    variant seen in live Portal traffic, and it cleanly decodes real launch calldata.
 *  - The CREATE2 address formula reproduces the real addresses of two live tokens (ROBIN, CLIPPY)
 *    from their own salts, which is what identifies **Tax Token V3** as the implementation.
 *  - A launch carrying bStake's exact policy simulates successfully against the live Portal via
 *    `eth_call`, against two different bStocks, returning the predicted token address.
 *
 * ## Three constraints that are not obvious, each found by a revert
 *
 *  1. **The salt must produce an address ending in `7777`.** Tax tokens require that suffix (a
 *     non-tax token needs `8888`). An arbitrary salt reverts. `findVanitySalt()` grinds one, which
 *     takes ~30k tries and under a second.
 *  2. **`dividendToken` cannot be zero when the quote asset is an ERC20** — even with
 *     `dividendBps` at zero. It is set to the quote token. The Portal says so in a revert string.
 *  3. **A creator buy needs an ERC20 approval to the Portal first.** The quote asset is pulled
 *     with `transferFrom`; a wallet holding plenty of the token still reverts at zero allowance.
 *     See `approveQuoteIfNeeded`.
 */


import {
  encodeFunctionData,
  getContractAddress,
  isAddress,
  keccak256,
  parseAbi,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from 'viem'

/**
 * Reads a required build-time value, refusing to fall back.
 *
 * A silent default here would be worse than a crash: it would produce a working-looking build that
 * routes real money to the wrong place, permanently.
 */
function requireEnv(name: string): `0x${string}` {
  const value = import.meta.env[name] as string | undefined
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env.local and fill it in.`)
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is not a valid address.`)
  return value as `0x${string}`
}

/** Verified on chain 30 Jul, re-checked 2 Aug, launch path re-verified 5 Aug 2026. */
export const FLAP = {
  /** Transparent proxy. `version()` returned `v5.16.0` on 2 Aug 2026. */
  portal: '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0',
  /** EIP-1967 implementation behind the proxy. Unverified source; changes on upgrade. */
  portalImplementation: '0xDC88feAFAa567b3303e1f85a07F1512c0629f362',
  launchpad: '0x1de460f363AF910f51726DEf188F9004276Bf4bc',
  vaultPortal: '0x90497450f2a706f1951b5bdda52B4E5d16f34C06',
  /**
   * Tax Token V3 implementation — `tokenVersion: 6`.
   *
   * ⚠ Load-bearing: the token address is CREATE2'd from an EIP-1167 proxy of THIS address, so a
   * wrong value here silently grinds salts for addresses that will never exist. Confirmed by
   * reproducing two live tokens' real addresses from their own salts.
   */
  taxTokenV3Impl: '0x024f18294970B5c76c0691b87f138A0317156422',
  /** PancakeSwap V3. Tokens migrate here when they graduate off the curve. */
  v3Factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
  wbnb: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
} as const

export const LAUNCH_ENCODER_READY = true

/**
 * Native value sent with a launch, in wei.
 *
 * Every observed bStock-quoted launch sends exactly this, whatever its creator buy — the quote
 * asset itself moves as an ERC20, not as value. (BNB-quoted launches instead send `value ==
 * quoteAmt`, which is not a case bStake has, since it always pairs against a bStock.)
 */
export const DEPLOY_FEE_WEI = 1_000_000_000n

/** What creator fees do here. The one thing that is firmly established. */
export const FEE_MODEL = {
  /**
   * flap does NOT push creator fees. They accrue inside the PancakeSwap V3 position the token
   * graduates into, and the beneficiary nominated at launch collects them from the Portal.
   */
  pushed: false,
  /**
   * ⚠ `claim(address)`, `claim(address,address)`, `claimFees(address)` and `collect(address)` were
   * all observed reverting on a later Portal implementation. Make the first claim through flap's
   * own creator UI and read what it actually sends before trusting any of them.
   */
  claimFunctionUnverified: true,
} as const

/**
 * Optional social links a creator can attach to a token.
 *
 * The same six flap.sh accepts, so a token launched here carries the identical metadata it would
 * have had if launched there. Every one is optional and empty strings are dropped before encoding.
 */
export type LaunchLinks = {
  telegram: string
  twitter: string
  github: string
  youtube: string
  debox: string
  website: string
}

export const EMPTY_LINKS: LaunchLinks = {
  telegram: '',
  twitter: '',
  github: '',
  youtube: '',
  debox: '',
  website: '',
}

export type LaunchParams = {
  name: string
  symbol: string
  description: string
  /** IPFS CID for the token image. */
  imageCid: string
  /** bStock ticker this token is paired against — decides the payout stock. */
  quoteAsset: string
  /** That bStock's contract address. The Portal pairs by address, not ticker. */
  quoteTokenAddress: string
  /**
   * The creator's optional initial buy, in the QUOTE ASSET's own smallest unit. A token paired
   * against NVDAB is bought with NVDAB, not BNB — and ⚠ against XAUT the unit is 6 decimals, not
   * 18, so this must be converted with the stock's own `decimals`.
   */
  quoteAmt: bigint
  /**
   * CREATE2 salt. Must come from `findVanitySalt()`: the Portal requires the resulting address to
   * end in `7777` and reverts otherwise.
   */
  salt: Hex
  links: LaunchLinks
}

export type LaunchTx = { to: string; data: string; value: bigint }

/**
 * The complete set of values a launch is encoded from: what the creator chose, plus the terms
 * bStake fixes for every launch.
 *
 * Resolving the two into one object here means the encoder cannot read a creator-supplied value
 * where a policy value belongs, and every policy field is applied by construction rather than by
 * remembering to pass it.
 */
export type ResolvedLaunch = LaunchParams & typeof LAUNCH_POLICY & { links: LaunchLinks }

export function resolveLaunch(params: LaunchParams): ResolvedLaunch {
  return {
    ...params,
    // Policy last, so nothing in `params` can ever override it.
    ...LAUNCH_POLICY,
    links: params.links,
  }
}

/* ------------------------------- the launch call ------------------------------- */

/**
 * `newTokenV6`, the Portal's launch entry point.
 *
 * Enum fields are `uint8`. This exact signature hashes to `0x8cb5772c`, the selector real launches
 * use — that match is what makes the ABI trustworthy rather than merely documented.
 */
// ⚠ One unbroken string literal on purpose. `parseAbi` infers its types from the literal, and
// splitting this across concatenated lines collapses the inferred ABI to `never`.
// prettier-ignore
export const PORTAL_ABI = parseAbi([
  'function newTokenV6((string name, string symbol, string meta, uint8 dexThresh, bytes32 salt, uint8 migratorType, address quoteToken, uint256 quoteAmt, address beneficiary, bytes permitData, bytes32 extensionID, bytes extensionData, uint8 dexId, uint8 lpFeeProfile, uint16 buyTaxRate, uint16 sellTaxRate, uint64 taxDuration, uint64 antiFarmerDuration, uint16 mktBps, uint16 deflationBps, uint16 dividendBps, uint16 lpBps, uint256 minimumShareBalance, address dividendToken, address commissionReceiver, uint8 tokenVersion) params) payable returns (address token)',
])

/**
 * Struct values that are identical in every launch flap's own UI makes, so bStake matches them
 * rather than inventing its own. Confirmed constant across every sampled live launch.
 */
const LAUNCH_SHAPE = {
  /** TWO_THIRDS. */
  dexThresh: 1,
  /** V2_MIGRATOR: the token graduates onto PancakeSwap V2. */
  migratorType: 1,
  dexId: 0,
  lpFeeProfile: 0,
  /** 100 years. flap's own UI sends this for a tax that never expires. */
  taxDuration: 3_153_600_000n,
  /** TOKEN_TAXED_V3, the implementation whose bytecode the address formula is built on. */
  tokenVersion: 6,
} as const

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const
const ZERO_BYTES32 = `0x${'00'.repeat(32)}` as const

/**
 * Builds the Portal launch call.
 *
 * ⚠ Encodes from `resolveLaunch(params)`, never from `params` — that is what applies the fee
 * recipient, the tax rates and the anti-farmer duration. Bypassing it silently drops all of them.
 */
export function buildLaunch(params: LaunchParams): LaunchTx {
  const p = resolveLaunch(params)

  if (!isAddress(p.quoteTokenAddress)) {
    throw new Error('The launch needs the bStock contract address to pair against.')
  }

  const data = encodeFunctionData({
    abi: PORTAL_ABI,
    functionName: 'newTokenV6',
    args: [
      {
        name: p.name,
        symbol: p.symbol,
        meta: p.imageCid,
        dexThresh: LAUNCH_SHAPE.dexThresh,
        salt: p.salt,
        migratorType: LAUNCH_SHAPE.migratorType,
        quoteToken: p.quoteTokenAddress,
        quoteAmt: p.quoteAmt,
        beneficiary: p.feeRecipient,
        permitData: '0x',
        extensionID: ZERO_BYTES32,
        extensionData: '0x',
        dexId: LAUNCH_SHAPE.dexId,
        lpFeeProfile: LAUNCH_SHAPE.lpFeeProfile,
        buyTaxRate: p.buyTaxBps,
        sellTaxRate: p.sellTaxBps,
        taxDuration: LAUNCH_SHAPE.taxDuration,
        antiFarmerDuration: BigInt(p.antiFarmerDurationSeconds),
        mktBps: p.creatorFundsAllocationBps,
        deflationBps: 0,
        dividendBps: 0,
        lpBps: 0,
        minimumShareBalance: 0n,
        // ⛔ Not the zero address. The Portal rejects that outright whenever the quote asset is an
        // ERC20, even though `dividendBps` is zero here: "dividendToken cannot be zero when
        // quoteToken is ERC20".
        dividendToken: p.quoteTokenAddress,
        commissionReceiver: ZERO_ADDRESS,
        tokenVersion: LAUNCH_SHAPE.tokenVersion,
      },
    ],
  })

  return { to: FLAP.portal, data, value: DEPLOY_FEE_WEI }
}

/* ------------------------------- the vanity salt ------------------------------- */

/**
 * EIP-1167 minimal proxy for the Tax Token V3 implementation. The Portal CREATE2-deploys this,
 * so hashing it with a salt gives the token's address before it exists.
 *
 * Verified by reproducing two live tokens' real addresses from their own salts.
 */
const PROXY_BYTECODE =
  `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${FLAP.taxTokenV3Impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3` as const

/** The address a given salt would produce. */
export function predictTokenAddress(salt: Hex): Address {
  return getContractAddress({
    from: FLAP.portal as Address,
    salt: toBytes(salt),
    bytecode: PROXY_BYTECODE,
    opcode: 'CREATE2',
  })
}

/**
 * Every flap tax token's address ends in this. The Portal enforces it, so a salt that misses it
 * reverts the launch.
 */
export const VANITY_SUFFIX = '7777'

/**
 * Grinds a salt whose token address carries the required suffix.
 *
 * Pure local hashing — no network. One suffix in 65,536 qualifies, so it lands in roughly 30k
 * tries and well under a second; the cap exists only so a mistake cannot spin forever.
 */
export function findVanitySalt(seed = `${Math.random()}`): { salt: Hex; address: Address } {
  for (let i = 0; i < 2_000_000; i++) {
    const salt = keccak256(toHex(`${seed}:${i}`))
    const address = predictTokenAddress(salt)
    if (address.toLowerCase().endsWith(VANITY_SUFFIX)) return { salt, address }
  }
  throw new Error('Could not prepare the launch. Please try again.')
}

/* ------------------------------- the quote approval ------------------------------- */

const ERC20_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

/** Calldata approving the Portal to pull `amount` of the quote asset for the creator's buy. */
export function buildApproval(quoteToken: Address, amount: bigint): LaunchTx {
  return {
    to: quoteToken,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [FLAP.portal as Address, amount] }),
    value: 0n,
  }
}

export { ERC20_ABI as QUOTE_ERC20_ABI }

/**
 * Submits a launch **from the creator's own wallet**.
 *
 * bStake builds the calldata; the creator's wallet signs it and pays the gas, so they are the
 * deployer and the token's owner on chain. bStake is never custodial and never needs a funded hot
 * wallet.
 *
 * Returns the transaction hash. The caller waits for the receipt, pulls the new token address out
 * of it with `tokenFromReceipt`, and calls `recordLaunch` so the token appears on /tokens. That
 * sequence lives in the Launch page rather than here, because pulling `flapIndexer` and `registry`
 * into this module would create an import cycle (`flapIndexer` already imports `FLAP` from here).
 */
export async function sendLaunch(
  params: LaunchParams,
  ctx: {
    provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
    from: string
  },
): Promise<`0x${string}`> {
  const tx = buildLaunch(params)

  const hash = await ctx.provider.request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: ctx.from,
        to: tx.to,
        data: tx.data,
        // Hex, not a bigint: JSON-RPC has no bigint and would serialise it as an object.
        value: `0x${tx.value.toString(16)}`,
      },
    ],
  })
  return hash as `0x${string}`
}

/**
 * Approves the Portal to pull the creator's initial buy, and waits for it to confirm.
 *
 * ⚠ Required before any launch with a non-zero `quoteAmt`. The Portal takes the quote asset with
 * `transferFrom`, so a wallet holding plenty of the bStock still reverts at zero allowance — the
 * failure looks like a broken launch rather than a missing approval, which is why this is a
 * separate, explicit step rather than something the launch call tries to do for itself.
 *
 * Returns the approval's transaction hash, or null when the allowance already covers the buy.
 */
export async function approveQuoteIfNeeded(
  args: { quoteToken: Address; amount: bigint; owner: Address },
  ctx: {
    provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
    readAllowance: (token: Address, owner: Address, spender: Address) => Promise<bigint>
  },
): Promise<`0x${string}` | null> {
  if (args.amount === 0n) return null

  const current = await ctx.readAllowance(args.quoteToken, args.owner, FLAP.portal as Address)
  if (current >= args.amount) return null

  const tx = buildApproval(args.quoteToken, args.amount)
  const hash = await ctx.provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: args.owner, to: tx.to, data: tx.data }],
  })
  return hash as `0x${string}`
}

/** `tokenFromReceipt` lives in `flapIndexer.ts`, next to the decoder it reuses. */

/** Pinning lives in `ipfs.ts`. See `pinImage` and `pinTokenMetadata`. */

/**
 * Launch terms that are **fixed for every token launched through bStake**.
 *
 * These are policy, not preferences: they are not surfaced anywhere in the UI, are not derived
 * from form state, and a creator cannot vary them. Anything encoding a launch reads them from
 * here, so there is exactly one place to change them and no path that can quietly disagree.
 *
 * ⚠ Do not add a control for any of these to the launch form, and do not display them. They were
 * settled by the operator on 5 Aug 2026.
 */
export const LAUNCH_POLICY = {
  /**
   * Fee recipient for every token launched here.
   *
   * Read from the environment so it is not committed to a public repository. It still reaches the
   * browser — the launch transaction has to carry it, and that transaction is public on chain — so
   * this is about keeping it out of source control, not about keeping it secret.
   *
   * ⚠ Deliberately not defaulted. A missing value here would encode launches with no beneficiary,
   * and the fee route of a launched token is IMMUTABLE, so the mistake could never be corrected.
   * Failing the build is the only safe behaviour.
   */
  feeRecipient: requireEnv('VITE_FEE_RECIPIENT'),

  /** Tax allocation: the whole tax take goes to the creator funds wallet. */
  creatorFundsAllocationBps: 10_000,

  /** Buy tax, in basis points. 200 = 2%. */
  buyTaxBps: 200,

  /** Sell tax, in basis points. 200 = 2%. */
  sellTaxBps: 200,

  /**
   * Anti-farmer protection duration, in seconds. Zero: bStake launches carry no such window.
   * Zero is the intended value, not an unset default — do not "fix" it to something non-zero.
   */
  antiFarmerDurationSeconds: 0,
} as const

/** Client-side validation shared by the form and the submit handler. */
export function validateLaunch(p: {
  name: string
  symbol: string
  quoteAsset: string
  /** The initial buy, denominated in the QUOTE ASSET — not BNB. */
  devBuy: string
  /** The creator's balance of that quote asset. Null when it is not known yet. */
  quoteBalance: number | null
}): Record<string, string> {
  const errors: Record<string, string> = {}

  const name = p.name.trim()
  if (!name) errors.name = 'Give your token a name.'
  else if (name.length > 32) errors.name = 'Keep the name to 32 characters or fewer.'

  const symbol = p.symbol.trim()
  if (!symbol) errors.symbol = 'Pick a ticker.'
  else if (!/^[A-Za-z0-9]{2,10}$/.test(symbol))
    errors.symbol = '2–10 letters or digits, no spaces or symbols.'

  if (!p.quoteAsset) errors.quoteAsset = 'Choose the stock your stakers get paid in.'

  if (p.devBuy.trim()) {
    const buy = Number(p.devBuy)
    if (!Number.isFinite(buy) || buy < 0) errors.devBuy = 'Enter a valid amount.'
    // A token paired against a bStock is bought WITH that bStock, so the balance that matters is
    // the creator's holding of the quote asset, never their BNB.
    else if (p.quoteBalance !== null && buy > p.quoteBalance)
      errors.devBuy = `That is more than your ${p.quoteAsset} balance.`
  }

  return errors
}
