#!/usr/bin/env node
// Publishes a built release to the MasterDeck update service (MasterDeck-Terminal#122):
// finds the update files (the mac zips, the Windows NSIS installer and its blockmap), hashes and
// signs each with the release key, uploads them to R2 through the backend's admin multipart routes
// and registers the release. `--dry-run` signs and prints the manifest without any network call.
//
//   node scripts/release-publish.mjs --dir dist --version 0.10.0 [--channel stable|beta]
//        [--notes notes.md] [--rollout 0-100] [--min-supported 0.9.0] [--expect-key <b64>] [--dry-run]
//
// It refuses a signing key whose public key is not the one built into the app
// (src/shared/releaseKey.ts), or `--expect-key`'s for an E2E run with a test key. A file the service
// already holds with the same size is not uploaded again, so a re-run reaches the idempotent publish.
//
// Env: MD_RELEASE_API (default https://dev.masterdeck.dev), RELEASE_ADMIN_TOKEN,
// RELEASE_SIGNING_KEY (PKCS8 PEM) or RELEASE_SIGNING_KEY_FILE. Node 22, no dependencies.
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_API = 'https://dev.masterdeck.dev'
// The Worker refuses requests over 100 MB and the backend takes parts up to 95 MB.
export const PART_SIZE = 90 * 1024 * 1024
const PART_TRIES = 4

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const RAW_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/

/** The key the app checks updates against, read out of releaseKey.ts's source. */
export function parseAppKey(text) {
  const m = /RELEASE_PUBLIC_KEY\s*=\s*'([A-Za-z0-9+/=]+)'/.exec(text)
  if (!m || !RAW_KEY.test(m[1])) throw new Error('no RELEASE_PUBLIC_KEY found in releaseKey.ts')
  return m[1]
}

/** The app's built-in release key (app/src/shared/releaseKey.ts). */
export async function appReleaseKey() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'shared', 'releaseKey.ts')
  return parseAppKey(await readFile(file, 'utf8'))
}

/** Throws unless the signing key's public key is `expected`: the app would refuse every file it signs. */
export function checkSigningKey(privateKeyPem, expected) {
  const got = publicKeyOf(privateKeyPem)
  if (got !== expected)
    throw new Error(`the signing key's public key ${got} does not match the app's ${expected} (pass --expect-key for a test key)`)
}

/** `-` in the version (0.10.0-beta.1) is the beta channel, else stable. */
export function channelOf(version) {
  return version.includes('-') ? 'beta' : 'stable'
}

/**
 * The update files of `version` under `dir` (searched recursively: downloaded CI artifacts sit in
 * one folder per job). Throws when one is missing or found twice.
 * @param {string} dir
 * @param {string} version
 * @returns {Promise<Array<{platform: string, arch: string, name: string, path: string,
 *   blockmap?: {name: string, path: string}}>>}
 */
export async function findUpdateFiles(dir, version) {
  const all = await listFiles(dir)
  const pick = (names) => {
    const hits = all.filter((f) => names.includes(baseName(f)))
    if (hits.length > 1) throw new Error(`found more than one of ${names.join(' / ')}: ${hits.join(', ')}`)
    return hits[0]
  }
  const want = [
    { platform: 'darwin', arch: 'arm64', names: [`MasterDeck-${version}-arm64-mac.zip`], name: `MasterDeck-${version}-arm64-mac.zip` },
    { platform: 'darwin', arch: 'x64', names: [`MasterDeck-${version}-mac.zip`], name: `MasterDeck-${version}-mac.zip` },
    // electron-builder names it "MasterDeck Setup <v>.exe"; it is published without the spaces.
    { platform: 'win32', arch: 'x64', names: [`MasterDeck Setup ${version}.exe`, `MasterDeck-Setup-${version}.exe`], name: `MasterDeck-Setup-${version}.exe`, blockmap: true },
  ]
  const missing = []
  const files = []
  for (const w of want) {
    const path = pick(w.names)
    if (!path) {
      missing.push(w.names[0])
      continue
    }
    const file = { platform: w.platform, arch: w.arch, name: w.name, path }
    if (w.blockmap) {
      const bm = pick(w.names.map((n) => `${n}.blockmap`))
      if (!bm) missing.push(`${w.names[0]}.blockmap`)
      else file.blockmap = { name: `${w.name}.blockmap`, path: bm }
    }
    files.push(file)
  }
  if (missing.length) throw new Error(`missing in ${dir}: ${missing.join(', ')}`)
  return files
}

async function listFiles(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listFiles(p)))
    else if (entry.isFile()) out.push(p)
  }
  return out
}

function baseName(p) {
  return p.split(/[\\/]/).pop()
}

/**
 * Base64 SHA-512 (electron-updater's format) and size of a file, streamed.
 * @param {string} path
 * @returns {Promise<{sha512: string, size: number}>}
 */
export async function hashFile(path) {
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha512: hash.digest('base64'), size }
}

/**
 * The message the release key signs (spec §1): UTF-8, lines joined by \n, no trailing newline.
 * @param {{version: string, platform: string, arch: string, name: string, sha512: string}} f
 */
export function signedMessage(f) {
  return ['masterdeck-update', 'v1', f.version, f.platform, f.arch, f.name, f.sha512].join('\n')
}

/**
 * Base64 Ed25519 signature of `message` with a PKCS8 PEM private key.
 * @param {string} message
 * @param {string} privateKeyPem
 */
export function signMessage(message, privateKeyPem) {
  return cryptoSign(null, Buffer.from(message, 'utf8'), loadKey(privateKeyPem)).toString('base64')
}

/** The raw 32-byte public key, base64, of a PKCS8 PEM Ed25519 private key. */
export function publicKeyOf(privateKeyPem) {
  const der = createPublicKey(loadKey(privateKeyPem)).export({ format: 'der', type: 'spki' })
  return der.subarray(der.length - 32).toString('base64')
}

function loadKey(pem) {
  const key = createPrivateKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`the release key must be Ed25519, not ${key.asymmetricKeyType}`)
  return key
}

/**
 * The body of POST /v1/admin/releases.
 * @param {{version: string, channel: string, notes: string, rolloutPercent?: number,
 *   minSupportedVersion?: string, files: Array<{platform: string, arch: string, name: string,
 *   sha512: string, size: number, signature: string}>}} r
 */
export function buildManifest(r) {
  const body = {
    version: r.version,
    channel: r.channel,
    notes: r.notes,
    files: r.files.map((f) => ({
      platform: f.platform,
      arch: f.arch,
      name: f.name,
      key: `${r.version}/${f.name}`,
      sha512: f.sha512,
      size: f.size,
      signature: f.signature,
    })),
  }
  if (r.minSupportedVersion) body.minSupportedVersion = r.minSupportedVersion
  if (r.rolloutPercent != null) body.rolloutPercent = r.rolloutPercent
  return body
}

/**
 * Hashes and signs every update file and returns the manifest plus what to upload.
 * @param {{dir: string, version: string, channel: string, notes: string, rolloutPercent?: number,
 *   minSupportedVersion?: string, privateKeyPem: string}} o
 */
export async function prepare(o) {
  const found = await findUpdateFiles(o.dir, o.version)
  const files = []
  const uploads = []
  for (const f of found) {
    const { sha512, size } = await hashFile(f.path)
    if (size === 0) throw new Error(`${f.name} is empty: ${f.path}`)
    const signature = signMessage(signedMessage({ ...f, version: o.version, sha512 }), o.privateKeyPem)
    files.push({ ...f, sha512, size, signature })
    uploads.push({ key: `${o.version}/${f.name}`, path: f.path, size })
    if (f.blockmap) {
      const bm = await stat(f.blockmap.path)
      if (bm.size === 0) throw new Error(`${f.blockmap.name} is empty: ${f.blockmap.path}`)
      uploads.push({ key: `${o.version}/${f.blockmap.name}`, path: f.blockmap.path, size: bm.size })
    }
  }
  return { manifest: buildManifest({ ...o, files }), uploads }
}

/**
 * Uploads one file through the admin multipart routes, part by part, each part tried up to four
 * times; a part that keeps failing aborts the upload and throws.
 * @param {{api: string, token: string, key: string, path: string, size: number,
 *   fetch?: typeof fetch, partSize?: number, sleep?: (ms: number) => Promise<void>,
 *   log?: (s: string) => void}} o
 */
export async function uploadFile(o) {
  const doFetch = o.fetch ?? fetch
  const partSize = o.partSize ?? PART_SIZE
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const log = o.log ?? (() => {})
  if (!(o.size > 0)) throw new Error(`${o.key} is empty`)
  const auth = { authorization: `Bearer ${o.token}` }
  const json = { ...auth, 'content-type': 'application/json' }

  const created = await call(doFetch, `${o.api}/v1/admin/uploads`, { method: 'POST', headers: json, body: JSON.stringify({ key: o.key }) })
  const uploadId = created.uploadId
  if (!uploadId) throw new Error(`no uploadId for ${o.key}`)
  const q = `key=${encodeURIComponent(o.key)}`
  const count = Math.max(1, Math.ceil(o.size / partSize))
  const parts = []
  const fh = await open(o.path, 'r')
  try {
    for (let n = 1; n <= count; n++) {
      const start = (n - 1) * partSize
      const len = Math.min(partSize, o.size - start)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, start)
      if (bytesRead !== len) throw new Error(`${o.path} changed while uploading`)
      let lastErr
      for (let attempt = 1; attempt <= PART_TRIES; attempt++) {
        try {
          const res = await call(doFetch, `${o.api}/v1/admin/uploads/${encodeURIComponent(uploadId)}/parts/${n}?${q}`, {
            method: 'PUT',
            headers: { ...auth, 'content-type': 'application/octet-stream' },
            body: buf,
          })
          parts.push({ partNumber: res.partNumber ?? n, etag: res.etag })
          lastErr = undefined
          break
        } catch (e) {
          lastErr = e
          log(`  part ${n}/${count} of ${o.key} failed (try ${attempt}/${PART_TRIES}): ${e.message}`)
          if (attempt < PART_TRIES) await sleep(2000 * attempt)
        }
      }
      if (lastErr) throw lastErr
      log(`  ${o.key}: part ${n}/${count}`)
    }
    return await call(doFetch, `${o.api}/v1/admin/uploads/${encodeURIComponent(uploadId)}/complete`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ key: o.key, parts }),
    })
  } catch (e) {
    try {
      await doFetch(`${o.api}/v1/admin/uploads/${encodeURIComponent(uploadId)}?${q}`, { method: 'DELETE', headers: auth })
    } catch {
      // The abort is best effort; R2 drops unfinished uploads by itself after a week.
    }
    throw e
  } finally {
    await fh.close()
  }
}

/**
 * Uploads every file, then registers the release.
 * @param {{api: string, token: string, manifest: ReturnType<typeof buildManifest>,
 *   uploads: Array<{key: string, path: string, size: number}>, fetch?: typeof fetch,
 *   partSize?: number, sleep?: (ms: number) => Promise<void>, log?: (s: string) => void}} o
 */
export async function publish({ api, token, manifest, uploads, fetch: doFetch = fetch, partSize, sleep, log = () => {} }) {
  for (const u of uploads) {
    if (await stored(doFetch, api, u)) {
      log(`${u.key} is already there (${u.size} bytes)`)
      continue
    }
    log(`uploading ${u.key} (${u.size} bytes)`)
    await uploadFile({ api, token, key: u.key, path: u.path, size: u.size, fetch: doFetch, partSize, sleep, log })
  }
  log(`publishing ${manifest.version} (${manifest.channel})`)
  return call(doFetch, `${api}/v1/admin/releases`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  })
}

/** The service already serves this file with this size (a re-run after a later step failed). */
async function stored(doFetch, api, u) {
  try {
    const res = await doFetch(`${api}/v1/updates/files/${u.key}`, { method: 'HEAD' })
    return res.status === 200 && Number(res.headers.get('content-length')) === u.size
  } catch {
    return false
  }
}

async function call(doFetch, url, init) {
  const res = await doFetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init.method} ${url.replace(/\?.*/, '')}: ${res.status} ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : {}
}

/** Parses the command line; throws on anything wrong. */
export function parseArgs(argv) {
  const o = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const val = () => {
      const v = argv[++i]
      if (v == null || v.startsWith('--')) throw new Error(`${a} needs a value`)
      return v
    }
    if (a === '--dir') o.dir = val()
    else if (a === '--version') o.version = val().replace(/^v/, '')
    else if (a === '--channel') o.channel = val()
    else if (a === '--notes') o.notesFile = val()
    else if (a === '--rollout') o.rollout = val()
    else if (a === '--min-supported') o.minSupported = val().replace(/^v/, '')
    else if (a === '--expect-key') o.expectKey = val()
    else if (a === '--dry-run') o.dryRun = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!o.dir) throw new Error('--dir is required')
  if (!o.version || !SEMVER.test(o.version)) throw new Error(`--version must be a version like 0.10.0, got ${o.version ?? 'nothing'}`)
  o.channel ??= channelOf(o.version)
  if (o.channel !== 'stable' && o.channel !== 'beta') throw new Error(`--channel must be stable or beta`)
  if (o.rollout != null) {
    if (!/^\d+$/.test(o.rollout) || Number(o.rollout) > 100) throw new Error('--rollout must be 0-100')
    o.rollout = Number(o.rollout)
  }
  if (o.minSupported != null && !SEMVER.test(o.minSupported)) throw new Error('--min-supported must be a version')
  if (o.expectKey != null && !RAW_KEY.test(o.expectKey)) throw new Error('--expect-key must be a raw Ed25519 public key (base64, 32 bytes)')
  return o
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const env = process.env
  let pem = env.RELEASE_SIGNING_KEY
  if (!pem && env.RELEASE_SIGNING_KEY_FILE) pem = await readFile(env.RELEASE_SIGNING_KEY_FILE, 'utf8')
  if (!pem || !pem.trim()) throw new Error('no signing key: set RELEASE_SIGNING_KEY (PKCS8 PEM) or RELEASE_SIGNING_KEY_FILE')
  // A file signed with another key would be refused by every installed app: stop before anything.
  checkSigningKey(pem, o.expectKey ?? (await appReleaseKey()))
  const notes = o.notesFile ? (await readFile(o.notesFile, 'utf8')).trim() : `MasterDeck ${o.version}`
  const token = env.RELEASE_ADMIN_TOKEN
  if (!o.dryRun && !token) throw new Error('RELEASE_ADMIN_TOKEN is not set')
  const api = (env.MD_RELEASE_API || DEFAULT_API).replace(/\/+$/, '')

  const { manifest, uploads } = await prepare({
    dir: o.dir,
    version: o.version,
    channel: o.channel,
    notes,
    rolloutPercent: o.rollout,
    minSupportedVersion: o.minSupported,
    privateKeyPem: pem,
  })
  console.error(`signed with public key ${publicKeyOf(pem)}`)
  if (o.dryRun) {
    console.log(JSON.stringify(manifest, null, 2))
    console.error(`dry run: would upload ${uploads.map((u) => u.key).join(', ')} to ${api}`)
    return
  }
  const res = await publish({ api, token, manifest, uploads, log: (s) => console.error(s) })
  console.log(JSON.stringify(res, null, 2))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`release-publish: ${e.message}`)
    process.exit(1)
  })
}
