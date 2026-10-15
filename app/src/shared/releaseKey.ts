import { DEFAULT_REMOTE_URL, validBackendUrl } from './account'

/**
 * The public half of MasterDeck's release signing key (Ed25519, raw 32 bytes, base64). Every update
 * file's signature is checked against it before anything is unpacked or run (docs/ARCHITECTURE.md
 * "In-app updates"). The private key lives only in CI secrets and on the owner's Mac.
 * scripts/release-publish.mjs reads this line to refuse a signing key that does not match it.
 */
export const RELEASE_PUBLIC_KEY = 'Xusi41mvk5IX9UIjHgEIY3VM/J5FPwYzRSn3j6KDkXA='

/** A raw Ed25519 public key in base64: 32 bytes. */
export function isRawKey(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(v)
}

/**
 * How this build may be steered for an update test. `testBuild` is true only in an app built with
 * MASTERDECK_UPDATE_TEST_BUILD=1 (electron-vite's define `__MD_UPDATE_TEST__`). Release builds never
 * set it, so no environment variable (any user process can `launchctl setenv`) changes where a
 * released app looks for updates or which key it trusts.
 */
export interface UpdateBuild {
  testBuild: boolean
  env: Record<string, string | undefined>
}

/**
 * The key updates are checked against. `MASTERDECK_UPDATE_PUBKEY` (a test key) is honoured only in
 * an update-test build launched isolated (`MASTERDECK_ISOLATED=1`).
 */
export function releaseKey(o: UpdateBuild): string {
  const k = o.env.MASTERDECK_UPDATE_PUBKEY?.trim()
  return o.testBuild && o.env.MASTERDECK_ISOLATED === '1' && isRawKey(k) ? k : RELEASE_PUBLIC_KEY
}

/**
 * The update service. `MASTERDECK_UPDATE_URL` (a local backend) is honoured in an update-test build
 * or a development run (where updates are off anyway); a packaged release asks the real service.
 */
export function updateBase(o: UpdateBuild & { packaged: boolean }): string {
  const own = o.testBuild || !o.packaged ? validBackendUrl(o.env.MASTERDECK_UPDATE_URL) : null
  return own ?? DEFAULT_REMOTE_URL
}
