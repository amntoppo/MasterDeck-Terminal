/**
 * This browser's key pair and approval record, per account (spec "Same account"), in IndexedDB.
 * CryptoKey objects are structured-cloneable, so the private key stays non-extractable at rest.
 */
export interface KeyRec {
  browserId: string | null
  pair: CryptoKeyPair
  /** The approval in progress / done: our nonce, and the Mac key + nonce the words were shown for. */
  nB?: string
  macPublicKey?: string
  macNonce?: string
  /** The Mac nonce we POSTed our reveal for (saved before the POST, for a reload that lost the answer). */
  revealFor?: string
}

export class StorageUnavailable extends Error {}

const DB = 'masterdeck-web', STORE = 'keys'

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((ok, no) => {
    r.onsuccess = () => ok(r.result)
    r.onerror = () => no(r.error)
  })
}

let db: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  db ??= new Promise<IDBDatabase>((ok, no) => {
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => ok(r.result)
    r.onerror = () => no(r.error)
    r.onblocked = () => no(new Error('blocked'))
  }).catch((e) => {
    db = null
    throw new StorageUnavailable(String(e))
  })
  return db
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  try {
    const s = (await open()).transaction(STORE, mode).objectStore(STORE)
    return await req(f(s))
  } catch (e) {
    throw e instanceof StorageUnavailable ? e : new StorageUnavailable(String(e))
  }
}

export const loadKeys = async (userId: string) => ((await tx('readonly', (s) => s.get(userId))) as KeyRec | undefined) ?? null
export const saveKeys = async (userId: string, rec: KeyRec) => void (await tx('readwrite', (s) => s.put(rec, userId)))
export const deleteKeys = async (userId: string) => void (await tx('readwrite', (s) => s.delete(userId)))

/** Another account signed in on this browser: its keys go (its row is revoked by its own sign-out, or by the Mac). */
export async function deleteOtherAccounts(userId: string): Promise<void> {
  const ids = (await tx('readonly', (s) => s.getAllKeys())) as string[]
  for (const id of ids) if (id !== userId) await deleteKeys(id)
}

/**
 * Load, or create and store a fresh pair; a failed write/read-back means a private window or blocked storage.
 * ponytail: private Safari/Firefox keep an in-memory IndexedDB that passes this check, so such a window gets approved
 * and loses its key on close; each re-approval then holds one of the 20 browser slots until revoked at /account or on
 * the Mac. Upgrade: navigator.storage.persist() heuristics, or expire unused browsers on the backend.
 */
export async function ensureKeys(userId: string, generate: () => Promise<CryptoKeyPair>): Promise<KeyRec> {
  const have = await loadKeys(userId)
  if (have) return have
  const rec: KeyRec = { browserId: null, pair: await generate() }
  await saveKeys(userId, rec)
  const back = await loadKeys(userId)
  if (!back?.pair?.privateKey) throw new StorageUnavailable('read-back failed')
  return back
}
