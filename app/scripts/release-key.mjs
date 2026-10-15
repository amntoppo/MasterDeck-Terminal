#!/usr/bin/env node
// Makes a new release signing key (MasterDeck-Terminal#122): an Ed25519 keypair. Writes the
// private key (PKCS8 PEM) to the path given, readable by its owner only, never over an existing
// file, and prints the raw public key (base64) for app/src/shared/releaseKey.ts and the backend's
// RELEASE_PUBLIC_KEY.
//
//   node scripts/release-key.mjs ~/.config/masterdeck-remote/release-signing-key.pem
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/release-key.mjs <private key path>')
  process.exit(2)
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
try {
  // "wx" refuses an existing file; mode 600 from the start, so the key is never readable by others.
  writeFileSync(out, pem, { flag: 'wx', mode: 0o600 })
} catch (e) {
  console.error(e.code === 'EEXIST' ? `${out} exists: not overwritten` : `could not write ${out}: ${e.message}`)
  process.exit(1)
}
const spki = publicKey.export({ format: 'der', type: 'spki' })
console.error(`private key written to ${out}`)
console.log(spki.subarray(spki.length - 32).toString('base64'))
