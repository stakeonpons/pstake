/**
 * Launch terms Stake fixes for every token launched here.
 *
 * ⚠⚠ **`LAUNCH_FEE_WALLET` is policy, never a form value.** It is the wallet every V1 token launched
 * through this site routes its fees to, and a creator can neither see it in the UI nor change it.
 * It is applied inside the launch transaction and is deliberately rendered nowhere.
 *
 * ⛔ Do NOT display this address anywhere in the interface. `brand.ts` documents why at length: a
 * fee address printed under a "set your creator-fee recipient to:" heading once existed here and
 * would have burned a creator's fee stream permanently. Keep it out of the UI entirely.
 *
 * ⚠ It is not, and cannot be, a *secret*. The launch transaction is public and
 * `locker.feeRedirects(token)` reads it straight back off chain. The requirement is that it is not
 * presented or editable in the front end — never claim it is unknowable.
 *
 * ⭐ Read from the environment rather than pasted here so it stays in step with the registry and
 * discovery services, which gate listings on the same value. `set-wallets.mjs` moves all of them
 * together; a literal here would silently drift out of agreement with the server.
 */
import { getAddress, isAddress, type Address } from 'viem'

function requireFeeWallet(): Address {
  const raw = (import.meta.env.VITE_FEE_RECIPIENT as string | undefined)?.trim() ?? ''
  if (!raw || !isAddress(raw.toLowerCase())) {
    throw new Error(
      'VITE_FEE_RECIPIENT is not set. Copy .env.example to .env.local and fill it in — a launch ' +
        'encoded without it would send every token’s fees to nobody.',
    )
  }
  return getAddress(raw.toLowerCase())
}

export const LAUNCH_FEE_WALLET: Address = requireFeeWallet()
