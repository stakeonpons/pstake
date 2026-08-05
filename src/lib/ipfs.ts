/**
 * Token metadata: the image and the social links, pinned to IPFS.
 *
 * flap stores a single `meta` string on chain per token. Every reader — flap's own site, bStake's
 * `/tokens` grid, explorers — resolves that to a JSON document holding the artwork and the links.
 * So the image is not uploaded on its own: it is pinned, its CID goes into a metadata document,
 * and that document's CID is what the launch transaction carries.
 *
 * ## The credential is not here, and must never be
 *
 * Uploads go through **bStake's own `/api/pin`**, which holds the Pinata key server side. Putting
 * it in a `VITE_` variable instead would compile it into the public JS bundle for anyone to read
 * and spend. Nothing in this file is secret, which is the point.
 *
 * The proxy sets the network and the filename itself, so this sends raw bytes rather than
 * multipart — there is no boundary to get wrong and no parser on either end.
 */

import type { LaunchLinks } from './flap'

const PIN_ENDPOINT = '/api/pin'

/** Uploads bytes through the proxy and returns the bare CID. */
async function pin(body: Blob, filename: string, type: string): Promise<string> {
  const res = await fetch(PIN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': type, 'X-File-Name': filename },
    body,
  })

  if (!res.ok) {
    // The proxy replies with a plain message; surface that rather than a status code.
    const detail = await res
      .json()
      .then((j: { error?: string }) => j.error)
      .catch(() => null)
    throw new Error(detail || 'Could not upload that file. Please try again.')
  }

  const json = (await res.json()) as { cid?: string }
  if (!json.cid) throw new Error('Could not upload that file. Please try again.')
  return json.cid
}

/** Pins the token image. Returns its bare CID. */
export async function pinImage(file: File): Promise<string> {
  return pin(file, file.name || 'image', file.type || 'image/png')
}

/**
 * Builds and pins the metadata document, returning the CID that goes on chain.
 *
 * Field names match what flap's own launches publish, so a token launched here is readable by
 * everything that already reads flap tokens — including `tokenMeta.ts` behind the `/tokens` grid.
 * Empty links are dropped rather than published as empty strings.
 */
export async function pinTokenMetadata(args: {
  name: string
  symbol: string
  description: string
  imageCid: string
  links: LaunchLinks
}): Promise<string> {
  const doc: Record<string, string> = {
    name: args.name,
    symbol: args.symbol,
    description: args.description,
    image: args.imageCid,
  }
  for (const [key, value] of Object.entries(args.links)) {
    if (value.trim()) doc[key] = value.trim()
  }

  const blob = new Blob([JSON.stringify(doc)], { type: 'application/json' })
  return pin(blob, `${args.symbol || 'token'}.json`, 'application/json')
}

/** Whether the creator supplied anything worth pinning. */
export function hasMetadata(image: File | null, links: LaunchLinks, description: string): boolean {
  return Boolean(image) || description.trim().length > 0 || Object.values(links).some((v) => v.trim())
}
