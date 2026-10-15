/**
 * The public half of MasterDeck's release signing key (Ed25519, raw 32 bytes, base64). Every update
 * file's signature is checked against it before anything is unpacked or run (docs/ARCHITECTURE.md
 * "In-app updates"). The private key lives only in CI secrets and on the owner's Mac.
 */
export const RELEASE_PUBLIC_KEY = 'Xusi41mvk5IX9UIjHgEIY3VM/J5FPwYzRSn3j6KDkXA='

/** A raw Ed25519 public key in base64: 32 bytes. */
export function isRawKey(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(v)
}

/**
 * The key updates are checked against. `MASTERDECK_UPDATE_PUBKEY` (a test key) is honoured only in
 * an isolated test launch (`MASTERDECK_ISOLATED=1`), so nothing on a user's machine can swap it.
 */
export function releaseKey(env: Record<string, string | undefined>): string {
  const k = env.MASTERDECK_UPDATE_PUBKEY?.trim()
  return env.MASTERDECK_ISOLATED === '1' && isRawKey(k) ? k : RELEASE_PUBLIC_KEY
}
