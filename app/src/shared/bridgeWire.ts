/** Plaintext messages inside the encrypted browser ↔ Mac channel (spec §3). Shared by the Mac bridge and the web app. */
export type WebToMac =
  | { k: 'call'; id: number; m: string; a: unknown[] }
  | { k: 'sub'; ev: string; arg?: string }
  | { k: 'unsub'; ev: string; arg?: string }
  | { k: 'visible'; on: boolean }
export type MacToWeb =
  | { k: 'ret'; id: number; ok: true; v: unknown }
  | { k: 'ret'; id: number; ok: false; e: string }
  | { k: 'ev'; ev: string; arg?: string; v: unknown[] }
  | { k: 'hello'; protocol: number; appVersion: string; platform: string; home: string }
