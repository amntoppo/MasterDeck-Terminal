import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { exportPrivate, generateStatic, importPrivate, importPublic, publicRaw } from '@shared/e2e'

export interface SafeStore { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string }

/** The Mac's long-term key for browsers, Keychain-encrypted (safeStorage). Null when encryption is unavailable. */
export async function loadMacKey(file: string, safe: SafeStore): Promise<{ pair: CryptoKeyPair; publicKey: string } | null> {
  if (!safe.isEncryptionAvailable()) return null
  if (existsSync(file)) {
    const { priv, pub } = JSON.parse(safe.decryptString(readFileSync(file))) as { priv: string; pub: string }
    return { pair: { privateKey: await importPrivate(priv), publicKey: await importPublic(pub) }, publicKey: pub }
  }
  const pair = await generateStatic(true)
  const pub = await publicRaw(pair.publicKey)
  const priv = await exportPrivate(pair.privateKey)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, safe.encryptString(JSON.stringify({ priv, pub })), { mode: 0o600 })
  chmodSync(file, 0o600)
  // Use the non-extractable copy from here on.
  return { pair: { privateKey: await importPrivate(priv), publicKey: pair.publicKey }, publicKey: pub }
}
