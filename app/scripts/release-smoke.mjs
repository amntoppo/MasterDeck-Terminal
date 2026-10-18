#!/usr/bin/env node
// Checks a published update the way an install finds and verifies it (MasterDeck-Terminal#178),
// right after ota-release.yml published it: for each platform (mac arm64, mac Intel, Windows) the
// check (/v1/updates/check) offers this version to an install inside the rollout, the per-install
// feed names it, the file downloads with the offered size and sha512, and its signature verifies
// against the app's release key. Reads only; a rollout of 0 offers it to nobody and checks nothing.
//
//   node scripts/release-smoke.mjs --version 0.9.2 [--rollout 0-100] [--expect-key <b64>]
//
// Env: MD_RELEASE_API (default https://dev.masterdeck.dev). Node 22, no dependencies.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DEFAULT_API, appReleaseKey, channelOf, signedMessage } from './release-publish.mjs'

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const RAW_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/
// Below every release, so the check offers the newest one.
const FROM = '0.0.0'

/** The update files of `version`, as release-publish.mjs registers them, and each one's feed. */
export function targets(version) {
  return [
    { platform: 'darwin', arch: 'arm64', name: `MasterDeck-${version}-arm64-mac.zip`, feed: 'latest-mac.yml' },
    { platform: 'darwin', arch: 'x64', name: `MasterDeck-${version}-mac.zip`, feed: 'latest-mac.yml' },
    { platform: 'win32', arch: 'x64', name: `MasterDeck-Setup-${version}.exe`, feed: 'latest.yml' },
  ]
}

/** The backend's rollout bucket of an install id (0-99): SHA-256's first 4 bytes, big-endian, mod 100. */
export function bucket(id) {
  return createHash('sha256').update(id, 'utf8').digest().readUInt32BE(0) % 100
}

/** An install id inside a rollout of `percent`, or null for 0 (nobody gets it). */
export function idInside(percent) {
  if (percent <= 0) return null
  for (let n = 0; ; n++) if (bucket(`release-smoke-${n}`) < percent) return `release-smoke-${n}`
}

/** True when `signature` (base64) is the release key's (raw, base64) over the file's signed message. */
export function signatureOk(publicKey, fields, signature) {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(publicKey, 'base64').toString('base64url') }, format: 'jwk' })
    return cryptoVerify(null, Buffer.from(signedMessage(fields), 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** What is wrong with the check's offer for target `t`, as lines (empty: nothing). */
export function offerProblems(offer, t, version, publicKey) {
  const where = `${t.platform}/${t.arch}`
  if (!offer || typeof offer !== 'object') return [`${where}: the check answered no offer`]
  const out = []
  if (offer.version !== version) out.push(`${where}: offered ${offer.version}, not ${version}`)
  if (offer.name !== t.name) out.push(`${where}: offered the file ${offer.name}, not ${t.name}`)
  if (typeof offer.url !== 'string' || !offer.url.startsWith('https://')) out.push(`${where}: the download address is not https: ${offer.url}`)
  if (!Number.isSafeInteger(offer.size) || offer.size <= 0) out.push(`${where}: no size`)
  if (!signatureOk(publicKey, { version, platform: t.platform, arch: t.arch, name: t.name, sha512: offer.sha512 }, String(offer.signature)))
    out.push(`${where}: the signature does not verify against the app's release key`)
  return out
}

/** Base64 SHA-512 and size of a download, streamed. */
async function downloadHash(doFetch, url) {
  const res = await doFetch(url)
  if (!res.ok || !res.body) throw new Error(`GET ${url}: ${res.status}`)
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of res.body) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha512: hash.digest('base64'), size }
}

async function tries(fn, { times = 3, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), wait = 10_000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= times) throw e
      await sleep(wait)
    }
  }
}

/**
 * Runs every check; throws one error listing every problem found.
 * @param {{api: string, version: string, rollout?: number, publicKey: string, fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>, log?: (s: string) => void}} o
 * @returns {Promise<{checked: string[], skipped?: string}>}
 */
export async function smoke({ api, version, rollout = 100, publicKey, fetch: doFetch = fetch, sleep, log = () => {} }) {
  // Bucket 0 is inside every rollout above 0, also one changed since (PATCH) or not known here.
  const id = idInside(Math.min(rollout, 1))
  if (!id) return { checked: [], skipped: `the rollout is 0 %: ${version} is offered to nobody yet` }
  const channel = channelOf(version)
  const problems = []
  const checked = []
  for (const t of targets(version)) {
    const where = `${t.platform}/${t.arch}`
    try {
      const q = new URLSearchParams({ version: FROM, platform: t.platform, arch: t.arch, channel, id })
      const offer = await tries(async () => {
        const res = await doFetch(`${api}/v1/updates/check?${q}`)
        if (res.status === 204) return null
        if (!res.ok) throw new Error(`the check answered ${res.status}`)
        return res.json()
      }, { sleep })
      const bad = offerProblems(offer, t, version, publicKey)
      if (bad.length) {
        problems.push(...bad)
        continue
      }
      const feedUrl = `${api}/v1/updates/feed/${channel}/${encodeURIComponent(id)}/${FROM}/${t.feed}`
      const feed = await tries(async () => {
        const res = await doFetch(feedUrl)
        if (!res.ok) throw new Error(`the feed ${t.feed} answered ${res.status}`)
        return res.text()
      }, { sleep })
      if (!feed.includes(`version: '${version}'`) || !feed.includes(offer.url)) problems.push(`${where}: the feed ${t.feed} does not name ${version}'s ${t.name}`)
      const got = await tries(() => downloadHash(doFetch, offer.url), { sleep })
      if (got.size !== offer.size) problems.push(`${where}: downloaded ${got.size} bytes, the offer says ${offer.size}`)
      else if (got.sha512 !== offer.sha512) problems.push(`${where}: the download's sha512 is not the offer's`)
      else {
        checked.push(t.name)
        log(`ok ${where}: ${t.name}, ${got.size} bytes, sha512 and signature verified`)
      }
    } catch (e) {
      problems.push(`${where}: ${e.message}`)
    }
  }
  if (problems.length) throw new Error(`${version} is not served as it should be:\n- ${problems.join('\n- ')}`)
  return { checked }
}

export function parseArgs(argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => {
      const x = argv[++i]
      if (x == null || x.startsWith('--')) throw new Error(`${a} needs a value`)
      return x
    }
    if (a === '--version') o.version = v()
    else if (a === '--rollout') o.rollout = v()
    else if (a === '--expect-key') o.expectKey = v()
    else throw new Error(`unknown argument ${a}`)
  }
  if (!o.version || !SEMVER.test(o.version)) throw new Error(`--version must be a version like 0.10.0, got ${o.version ?? 'nothing'}`)
  if (o.rollout == null || o.rollout === '') o.rollout = 100
  else if (!/^\d+$/.test(o.rollout) || Number(o.rollout) > 100) throw new Error('--rollout must be 0-100')
  else o.rollout = Number(o.rollout)
  if (o.expectKey != null && !RAW_KEY.test(o.expectKey)) throw new Error('--expect-key must be a raw Ed25519 public key (base64, 32 bytes)')
  return o
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const api = (process.env.MD_RELEASE_API || DEFAULT_API).replace(/\/+$/, '')
  const res = await smoke({ api, version: o.version, rollout: o.rollout, publicKey: o.expectKey ?? (await appReleaseKey()), log: (s) => console.log(s) })
  if (res.skipped) console.log(`::notice::Smoke check skipped: ${res.skipped}.`)
  else console.log(`${o.version}: every update file is offered, downloads and verifies (${api}).`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`release-smoke: ${e.message}`)
    process.exit(1)
  })
}
