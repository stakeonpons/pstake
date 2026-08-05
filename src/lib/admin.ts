/**
 * Admin gating.
 *
 * The published build ships no admin controls: managing the token registry is operator tooling
 * rather than part of the product, so it lives outside this repository. These stubs keep the shape
 * the rest of the app expects.
 */

export const ADMIN_IS_UI_ONLY = true

export function isAdminAddress(_address: string | null): boolean {
  return false
}

export function isUnconfiguredAdmin(_address: string | null): boolean {
  return false
}

export function isDevOverrideAdmin(): boolean {
  return false
}

export async function signAdminAction(
  _provider: { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> },
  _address: string,
  _action: string,
): Promise<{ message: string; signature: string }> {
  throw new Error('Not available in this build.')
}
