import type { Operation } from 'fast-json-patch'

/** Plaintext messages inside the encrypted browser ↔ Mac channel (spec §3). Shared by the Mac bridge and the web app. */
export type WebToMac =
  | { k: 'call'; id: number; m: string; a: unknown[] }
  /** `patches: 1` (state only): this web applies `evp`; an older Mac ignores it and keeps sending full state. */
  | { k: 'sub'; ev: string; arg?: string; patches?: 1 }
  | { k: 'unsub'; ev: string; arg?: string }
  | { k: 'visible'; on: boolean }
  /** Patch stream broken (gap, failed apply): send a full state again. */
  | { k: 'resync'; ev: string }
export type MacToWeb =
  | { k: 'ret'; id: number; ok: true; v: unknown }
  | { k: 'ret'; id: number; ok: false; e: string }
  /** `n` numbers state messages (full or patch) per subscription, only for a `patches: 1` subscriber. */
  | { k: 'ev'; ev: string; arg?: string; v: unknown[]; n?: number }
  /** State patch: `ops` turn state n-1 into state n. */
  | { k: 'evp'; ev: string; n: number; ops: Operation[] }
  | { k: 'hello'; protocol: number; appVersion: string; platform: string; home: string }
