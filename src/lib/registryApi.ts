/**
 * Client for the shared token registry.
 *
 * Replaces the per-browser `localStorage` list as the source of truth. A token launched through
 * bStake is now visible to every visitor, which is the whole point of `/tokens` being a public
 * page rather than a private note.
 *
 * ## What the server does that the browser cannot
 *
 * It **verifies the listing against the chain**: a token is accepted only if its fee beneficiary is
 * bStake's. That check is meaningless client side — anything can POST to the endpoint — so this
 * module deliberately does not pre-judge. It submits the address and lets the server decide.
 *
 * ## Failure behaviour
 *
 * Every call degrades rather than throwing the page away. If the API is unreachable, `fetchListed`
 * returns null and the caller falls back to whatever the browser recorded locally, so a launcher
 * still sees their own token even during an outage.
 */

import type { Address } from 'viem'

export type ListedToken = {
  address: Address
  /** `verified` — the chain confirmed the fee route. `admin` — listed deliberately by signature. */
  source: 'verified' | 'admin'
  beneficiary: string
  reward: string | null
  addedAt: number
}

const BASE = '/api/tokens'

/** Null means "could not reach the registry", which is not the same as "there are none". */
export async function fetchListed(): Promise<ListedToken[] | null> {
  try {
    const res = await fetch(BASE, { headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { tokens?: ListedToken[] }
    return Array.isArray(body.tokens) ? body.tokens : null
  } catch {
    return null
  }
}

export type SubmitResult = { ok: true; source: 'verified' | 'admin' } | { ok: false; error: string }

/**
 * Submits a token for listing.
 *
 * Accepted only if the chain says its fees route to bStake — or, for a deliberate exception, if
 * `admin` carries a signature the server can recover to an admin wallet.
 */
export async function submitToken(args: {
  address: string
  reward?: string | null
  admin?: { address: string; message: string; signature: string }
}): Promise<SubmitResult> {
  try {
    const res = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ⚠ `admin` is nested, never spread. Spreading it would overwrite `address` — which here
      // means the token — with the admin's own wallet, and the listing would be for the wrong thing.
      body: JSON.stringify({
        address: args.address,
        reward: args.reward ?? null,
        admin: args.admin ?? null,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; source?: string; error?: string }
    if (res.ok && body.ok) return { ok: true, source: (body.source as 'verified' | 'admin') ?? 'verified' }
    return { ok: false, error: body.error || 'That token could not be listed.' }
  } catch {
    return { ok: false, error: 'The registry is unreachable. Try again shortly.' }
  }
}

/**
 * Removes a token, and keeps it removed.
 *
 * Always needs an admin signature. The server also records the address as hidden, because a token
 * that genuinely pays bStake would otherwise be re-listed by discovery within minutes.
 */
export async function removeToken(
  address: string,
  admin: { address: string; message: string; signature: string },
): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/${address}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ admin }),
    })
    return res.ok
  } catch {
    return false
  }
}
