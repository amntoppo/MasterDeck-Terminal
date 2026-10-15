import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { signedMessage, type SignedFields, type UpdateErrorKind } from '@shared/updates'

/** A failed step of an update, with the kind Settings shows. The message never carries a path. */
export class UpdateFailure extends Error {
  constructor(
    readonly kind: UpdateErrorKind,
    message: string,
  ) {
    super(message)
  }
}

// An Ed25519 public key's SPKI DER is this prefix followed by the raw 32 bytes.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')

/** The release file's signature checks out against the raw base64 public key. */
export function signatureOk(fields: SignedFields, signature: string, publicKey: string): boolean {
  try {
    const raw = Buffer.from(publicKey, 'base64')
    if (raw.length !== 32) return false
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(signedMessage(fields), 'utf8'), key, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

/** A file's SHA-512 (base64) and size, read as a stream. */
export function hashFile(path: string): Promise<{ sha512: string; size: number }> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha512')
    let size = 0
    createReadStream(path)
      .on('data', (c) => {
        size += c.length
        h.update(c)
      })
      .on('error', reject)
      .on('end', () => resolve({ sha512: h.digest('base64'), size }))
  })
}

/**
 * The downloaded file is the one the release signed: its hash and size match the offer, and the
 * offer's fields (version, platform, arch, name, hash) carry the release key's signature.
 * Throws UpdateFailure('verify').
 */
export function checkRelease(
  got: { sha512: string; size: number },
  offer: { version: string; name: string; sha512: string; size: number; signature: string },
  platform: string,
  arch: string,
  publicKey: string,
): void {
  if (got.sha512 !== offer.sha512 || got.size !== offer.size) throw new UpdateFailure('verify', 'The downloaded file does not match the release')
  const fields = { version: offer.version, platform, arch, name: offer.name, sha512: offer.sha512 }
  if (!signatureOk(fields, offer.signature, publicKey)) throw new UpdateFailure('verify', 'The release signature is not valid')
}
