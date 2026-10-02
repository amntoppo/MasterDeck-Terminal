import { fromB64u, toB64u } from './b64'
import { WORDS } from './wordlist'

const subtle = globalThis.crypto.subtle
export const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const
const enc = new TextEncoder(), dec = new TextDecoder()
export class E2EError extends Error {}
export interface Channel { seal(msg: unknown): Promise<string>; open(frame: string): Promise<unknown> }
export interface Hs1 { k: 'hs1'; e: string; n: string }
export interface Hs2 { k: 'hs2'; e: string; n: string; tag: string }
export interface Hs3 { k: 'hs3'; tag: string }

const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length } return out }
const sha256 = async (b: Uint8Array<ArrayBuffer>) => new Uint8Array(await subtle.digest('SHA-256', b))

export const generateStatic = (extractable: boolean) => subtle.generateKey(CURVE, extractable, ['deriveBits']) as Promise<CryptoKeyPair>
export const publicRaw = async (k: CryptoKey) => toB64u(new Uint8Array(await subtle.exportKey('raw', k)))
/** Decode base64url, optionally requiring an exact length; any failure is an E2EError. */
const bytes = (s: string, len?: number): Uint8Array<ArrayBuffer> => {
  let b: Uint8Array<ArrayBuffer>
  try { b = fromB64u(s) } catch { throw new E2EError('malformed input') }
  if (len !== undefined && b.length !== len) throw new E2EError('malformed input')
  return b
}
export const importPublic = async (raw: string) => {
  const b = bytes(raw, 65)
  if (b[0] !== 4) throw new E2EError('malformed public key')
  try { return await subtle.importKey('raw', b, CURVE, true, []) } catch { throw new E2EError('malformed public key') }
}
export const exportPrivate = async (k: CryptoKey) => toB64u(new Uint8Array(await subtle.exportKey('pkcs8', k)))
export const importPrivate = (p: string) => subtle.importKey('pkcs8', bytes(p), CURVE, false, ['deriveBits'])
const dh = async (priv: CryptoKey, pubRaw: string) => new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await importPublic(pubRaw) }, priv, 256))

export const randomNonce = () => toB64u(crypto.getRandomValues(new Uint8Array(16)))
export const commitment = async (browserPub: string, nonce: string) =>
  toB64u(await sha256(cat(enc.encode('masterdeck-commit-v1'), bytes(browserPub), bytes(nonce))))
export async function checkCommitment(commit: string, browserPub: string, nonce: string): Promise<boolean> {
  try {
    const want = bytes(await commitment(browserPub, nonce)), got = bytes(commit, 32)
    let diff = 0
    for (let i = 0; i < want.length; i++) diff |= want[i] ^ got[i]
    return diff === 0
  } catch { return false }
}

export async function words(macPub: string, browserPub: string, macNonce: string, browserNonce: string): Promise<[string, string, string]> {
  const h = await sha256(cat(enc.encode('masterdeck-sas-v2'), bytes(macPub), bytes(browserPub), bytes(macNonce), bytes(browserNonce)))
  // First 33 bits of the hash (BigInt: 33 bits don't fit in a JS bitwise int).
  const n = (BigInt(h[0]) << 25n) | (BigInt(h[1]) << 17n) | (BigInt(h[2]) << 9n) | (BigInt(h[3]) << 1n) | (BigInt(h[4]) >> 7n)
  const at = (i: number) => WORDS[Number((n >> BigInt(22 - 11 * i)) & 2047n)]
  return [at(0), at(1), at(2)]
}

const B2M = 0x42324d31, M2B = 0x4d324231 // "B2M1", "M2B1"
const AAD = enc.encode('masterdeck-e2e-v1')

function makeChannel(sendKey: CryptoKey, recvKey: CryptoKey, sendDir: number, recvDir: number): Channel {
  let sendCtr = 0n, recvCtr = 0n, dead = false
  let sendQ: Promise<unknown> = Promise.resolve(), recvQ: Promise<unknown> = Promise.resolve()
  const nonce = (dir: number, ctr: bigint) => { const n = new Uint8Array(12); const v = new DataView(n.buffer); v.setUint32(0, dir); v.setBigUint64(4, ctr); return n }
  // Calls run one at a time in call order, so counters stay in step under concurrency.
  const chain = <T>(q: Promise<unknown>, f: () => Promise<T>): [Promise<T>, Promise<unknown>] => { const p = q.then(f); return [p, p.catch(() => undefined)] }
  return {
    seal(msg) {
      const [p, q] = chain(sendQ, async () => {
        if (dead) throw new E2EError('channel closed')
        const json = JSON.stringify(msg)
        if (json === undefined) throw new E2EError('message not serializable')
        const iv = nonce(sendDir, sendCtr++)
        return toB64u(new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, sendKey, enc.encode(json))))
      })
      sendQ = q
      return p
    },
    open(frame) {
      const [p, q] = chain(recvQ, async () => {
        if (dead) throw new E2EError('channel closed')
        try {
          const pt = await subtle.decrypt({ name: 'AES-GCM', iv: nonce(recvDir, recvCtr), additionalData: AAD }, recvKey, fromB64u(frame))
          recvCtr++
          return JSON.parse(dec.decode(pt))
        } catch { dead = true; throw new E2EError('frame rejected') } // fail closed
      })
      recvQ = q
      return p
    },
  }
}

async function derive(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>) {
  const base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  const bits = new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('masterdeck-e2e-v1 keys') }, base, 96 * 8))
  const aes = (b: Uint8Array<ArrayBuffer>) => subtle.importKey('raw', b, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const conf = await subtle.importKey('raw', bits.slice(64, 96), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  return { kBM: await aes(bits.slice(0, 32)), kMB: await aes(bits.slice(32, 64)), conf }
}
const tag = async (k: CryptoKey, who: string) => toB64u(new Uint8Array(await subtle.sign('HMAC', k, enc.encode(who))))
const check = async (k: CryptoKey, who: string, t: string) => {
  let ok = false
  try { ok = await subtle.verify('HMAC', k, fromB64u(t), enc.encode(who)) } catch { /* malformed tag */ }
  if (!ok) throw new E2EError('handshake failed')
}

async function keys(sB: string, sM: string, eB: string, eM: string, nB: string, nM: string, d1: Uint8Array<ArrayBuffer>, d2: Uint8Array<ArrayBuffer>, d3: Uint8Array<ArrayBuffer>) {
  const salt = await sha256(cat(enc.encode('masterdeck-e2e-v1'), ...[sB, sM, eB, eM, nB, nM].map(fromB64u)))
  return derive(cat(d1, d2, d3), salt)
}

export async function browserHandshake(me: CryptoKeyPair, macPub: string) {
  const e = await generateStatic(false), ePub = await publicRaw(e.publicKey), meePub = await publicRaw(me.publicKey), n = randomNonce()
  return {
    hs1: { k: 'hs1', e: ePub, n } as Hs1,
    async finish(hs2: Hs2) {
      try {
        bytes(hs2.n, 16)
        // ECDH(eB,eM) || ECDH(sB,eM) || ECDH(eB,sM)
        const k = await keys(meePub, macPub, ePub, hs2.e, n, hs2.n, await dh(e.privateKey, hs2.e), await dh(me.privateKey, hs2.e), await dh(e.privateKey, macPub))
        await check(k.conf, 'mac', hs2.tag)
        return { hs3: { k: 'hs3', tag: await tag(k.conf, 'browser') } as Hs3, channel: makeChannel(k.kBM, k.kMB, B2M, M2B) }
      } catch (err) { throw err instanceof E2EError ? err : new E2EError('handshake failed') }
    },
  }
}

export async function macHandshake(me: CryptoKeyPair, browserPub: string, hs1: Hs1) {
  const e = await generateStatic(false), ePub = await publicRaw(e.publicKey), mePub = await publicRaw(me.publicKey), n = randomNonce()
  let k: Awaited<ReturnType<typeof derive>>
  try {
    bytes(hs1.n, 16)
    k = await keys(browserPub, mePub, hs1.e, ePub, hs1.n, n, await dh(e.privateKey, hs1.e), await dh(e.privateKey, browserPub), await dh(me.privateKey, hs1.e))
  } catch { throw new E2EError('handshake failed') }
  return {
    hs2: { k: 'hs2', e: ePub, n, tag: await tag(k.conf, 'mac') } as Hs2,
    async confirm(hs3: Hs3) {
      try { await check(k.conf, 'browser', hs3.tag) } catch { throw new E2EError('handshake failed') }
      return makeChannel(k.kMB, k.kBM, M2B, B2M)
    },
  }
}
