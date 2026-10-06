# Linked sessions (#67) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user link MasterDeck sessions to each other (two-way, persisted) and have linked sessions see each other's running summary automatically and on demand.

**Architecture:** A small JSON store (`session-peers.json`) of pairwise edges keyed by `Session.key`, exposed as `AppState.peers`. A `PeerSync` in main regenerates a linked session's summary when its turn ends (debounced) and feeds peers through the existing SessionStart context file plus a per-prompt delta file read by the UserPromptSubmit hook. UI: a picker in both start dialogs and a "Linked sessions" section in the details panel.

**Tech Stack:** Electron (electron-vite), React 19, TypeScript, vitest; the deck hook is a POSIX sh script generated in `main/deckHooks.ts`.

**Spec:** `docs/superpowers/specs/2026-10-07-linked-sessions-design.md`

All paths below are relative to `app/` unless they start with `docs/`. Run tests from `app/`: `npx vitest run <file>`; whole suite `npm test`; types `npm run typecheck`.

## Global Constraints

- Internal name is **peers** (`PeerStore`, `peers.ts`, `AppState.peers`, `CH.peersSet`, `CH.peersSync`); UI copy says "Linked sessions". Never reuse `link*` names (those are session ↔ ticket).
- Edges keyed by `Session.key`; pairwise, unordered, deduped, no self-edge; `MAX_PEERS = 8`.
- Store file `<MASTERDECK_HOME>/session-peers.json`, shape `{ version: 1, edges: [[a,b],…], seen: { T: { P: at } } }`, written temp+rename; a corrupt file is moved aside to `session-peers.json.corrupt-<ts>` and treated as empty.
- Sessions with no peers: no automatic summaries, no context block, no delta file. Behaviour identical to today.
- Automatic summary: only on Stop of a session with ≥1 peer, only when `stale`, at most once per 2 minutes per session (`PEER_SYNC_MIN_MS = 120_000`), one in flight per session.
- Context caps: at most 5 peers in a block, newest summary first, 2500 characters per summary.
- Every new `DeckApi` member gets a `DECK_ACCESS` entry (`remote`), or `remoteDeck.test.ts` fails.
- Deck hooks exist on non-Windows only; `peersSync` falls back to `Sender` when `process.platform === 'win32'` or hooks are not installed.
- Public repo: no company names, private repos, people or real paths in code, tests or docs (fixtures use org `acme`).
- Code style as the surrounding file (main/ and shared/ files mix semicolon styles; match the file you edit). Prettier is not enforced.

## Review Focus

1. Linking A→B then B→A again must be a no-op (one edge), and removing from either side removes both views. Pinned: Task 1 `peers.test.ts` symmetry test.
2. A session that ends while linked must disappear from its peers on the next build and its delta files must go. Pinned: Task 2 prune test + Task 5 `refresh` after prune test.
3. A resumed session whose key changes must keep its edges. Pinned: Task 2 `carry` test.
4. A peer with no summary yet must still appear in the block as "(no summary yet)" with its facts, never crash the context write. Pinned: Task 4 `deckHooks.test.ts`.
5. A delta must be consumed exactly once: a second prompt with no change gets nothing; a change while the session is mid-turn produces one delta, not two. Pinned: Task 4 hook-script test and Task 5 `seen` bookkeeping test.

---

### Task 1: Pure peer graph (`shared/peers.ts`)

**Files:**
- Create: `src/shared/peers.ts`
- Test: `src/shared/peers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAX_PEERS = 8;
  export type Edge = [string, string];
  export interface PeerData { version: 1; edges: Edge[]; seen: Record<string, Record<string, number>> }
  export function emptyPeers(): PeerData;
  export function parsePeers(raw: unknown): PeerData | null;        // null: not a valid file
  export function peersOf(d: PeerData, key: string): string[];       // sorted, unique
  export function addEdge(d: PeerData, a: string, b: string): { ok: true } | { ok: false; message: string }; // mutates d
  export function removeEdge(d: PeerData, a: string, b: string): boolean; // true when something was removed; also drops seen[a][b] and seen[b][a]
  export function pruneEdges(d: PeerData, live: Set<string>): string[]; // removes every edge with a dead endpoint; returns the dead keys touched; drops their seen rows
  export function carryKey(d: PeerData, oldKey: string, newKey: string): boolean; // rewrite oldKey → newKey in edges and seen
  export function adjacency(d: PeerData): Record<string, string[]>;   // AppState.peers
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/shared/peers.test.ts
import { describe, expect, it } from 'vitest'
import { MAX_PEERS, addEdge, adjacency, carryKey, emptyPeers, parsePeers, peersOf, pruneEdges, removeEdge } from './peers'

describe('peers graph', () => {
  it('adds one undirected edge, deduped', () => {
    const d = emptyPeers()
    expect(addEdge(d, 'a', 'b')).toEqual({ ok: true })
    expect(addEdge(d, 'b', 'a')).toEqual({ ok: true })
    expect(d.edges).toHaveLength(1)
    expect(peersOf(d, 'a')).toEqual(['b'])
    expect(peersOf(d, 'b')).toEqual(['a'])
  })
  it('refuses a self edge and an empty key', () => {
    const d = emptyPeers()
    expect(addEdge(d, 'a', 'a').ok).toBe(false)
    expect(addEdge(d, '', 'a').ok).toBe(false)
  })
  it('refuses more than MAX_PEERS on either side', () => {
    const d = emptyPeers()
    for (let i = 0; i < MAX_PEERS; i++) expect(addEdge(d, 'a', `p${i}`).ok).toBe(true)
    const r = addEdge(d, 'a', 'one-more')
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.message).toMatch(/8/)
    expect(addEdge(d, 'one-more', 'a').ok).toBe(false)
  })
  it('removes from either side and clears seen', () => {
    const d = emptyPeers()
    addEdge(d, 'a', 'b')
    d.seen = { a: { b: 5 }, b: { a: 6 } }
    expect(removeEdge(d, 'b', 'a')).toBe(true)
    expect(removeEdge(d, 'b', 'a')).toBe(false)
    expect(peersOf(d, 'a')).toEqual([])
    expect(d.seen).toEqual({ a: {}, b: {} })
  })
  it('prunes dead endpoints and their seen rows', () => {
    const d = emptyPeers()
    addEdge(d, 'a', 'b')
    addEdge(d, 'a', 'c')
    d.seen = { a: { b: 1, c: 2 }, b: { a: 1 } }
    expect(pruneEdges(d, new Set(['a', 'c']))).toEqual(['b'])
    expect(peersOf(d, 'a')).toEqual(['c'])
    expect(d.seen.b).toBeUndefined()
    expect(d.seen.a).toEqual({ c: 2 })
  })
  it('carries a key to a new one', () => {
    const d = emptyPeers()
    addEdge(d, 'old', 'b')
    d.seen = { old: { b: 3 }, b: { old: 4 } }
    expect(carryKey(d, 'old', 'new')).toBe(true)
    expect(peersOf(d, 'new')).toEqual(['b'])
    expect(peersOf(d, 'b')).toEqual(['new'])
    expect(d.seen).toEqual({ new: { b: 3 }, b: { new: 4 } })
    expect(carryKey(d, 'gone', 'x')).toBe(false)
  })
  it('builds a symmetric adjacency', () => {
    const d = emptyPeers()
    addEdge(d, 'a', 'b')
    addEdge(d, 'c', 'a')
    expect(adjacency(d)).toEqual({ a: ['b', 'c'], b: ['a'], c: ['a'] })
  })
  it('parses a valid file and rejects garbage', () => {
    expect(parsePeers({ version: 1, edges: [['a', 'b']], seen: {} })).toEqual({ version: 1, edges: [['a', 'b']], seen: {} })
    expect(parsePeers({ version: 1, edges: [['a', 'b'], ['a', 'a'], ['b', 'a'], 'x'], seen: { a: { b: 'no' } } })).toEqual({ version: 1, edges: [['a', 'b']], seen: { a: {} } })
    expect(parsePeers(null)).toBeNull()
    expect(parsePeers({ version: 2 })).toBeNull()
    expect(parsePeers('[]')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run src/shared/peers.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/shared/peers.ts`**

```ts
/** Session ↔ session links ("Linked sessions"): a pairwise, undirected graph keyed by Session.key. */

export const MAX_PEERS = 8

export type Edge = [string, string]

export interface PeerData {
  version: 1
  edges: Edge[]
  /** seen[T][P]: the `at` of P's summary that T last received. */
  seen: Record<string, Record<string, number>>
}

export function emptyPeers(): PeerData {
  return { version: 1, edges: [], seen: {} }
}

const norm = (a: string, b: string): Edge => (a < b ? [a, b] : [b, a])
const has = (d: PeerData, a: string, b: string): boolean => d.edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a))

export function peersOf(d: PeerData, key: string): string[] {
  const out = new Set<string>()
  for (const [a, b] of d.edges) {
    if (a === key) out.add(b)
    else if (b === key) out.add(a)
  }
  return [...out].sort()
}

export function addEdge(d: PeerData, a: string, b: string): { ok: true } | { ok: false; message: string } {
  if (!a || !b) return { ok: false, message: 'bad session' }
  if (a === b) return { ok: false, message: 'a session cannot be linked to itself' }
  if (has(d, a, b)) return { ok: true }
  for (const k of [a, b]) if (peersOf(d, k).length >= MAX_PEERS) return { ok: false, message: `a session can be linked to at most ${MAX_PEERS} others` }
  d.edges.push(norm(a, b))
  return { ok: true }
}

export function removeEdge(d: PeerData, a: string, b: string): boolean {
  const n = d.edges.length
  d.edges = d.edges.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)))
  if (d.seen[a]) delete d.seen[a][b]
  if (d.seen[b]) delete d.seen[b][a]
  return d.edges.length !== n
}

export function pruneEdges(d: PeerData, live: Set<string>): string[] {
  const dead = new Set<string>()
  d.edges = d.edges.filter(([a, b]) => {
    const ok = live.has(a) && live.has(b)
    if (!ok) for (const k of [a, b]) if (!live.has(k)) dead.add(k)
    return ok
  })
  for (const k of dead) {
    delete d.seen[k]
    for (const row of Object.values(d.seen)) delete row[k]
  }
  return [...dead].sort()
}

export function carryKey(d: PeerData, oldKey: string, newKey: string): boolean {
  if (!oldKey || !newKey || oldKey === newKey) return false
  let changed = false
  d.edges = d.edges.map(([a, b]) => {
    if (a !== oldKey && b !== oldKey) return [a, b] as Edge
    changed = true
    return norm(a === oldKey ? newKey : a, b === oldKey ? newKey : b)
  })
  if (d.seen[oldKey]) {
    d.seen[newKey] = { ...(d.seen[newKey] ?? {}), ...d.seen[oldKey] }
    delete d.seen[oldKey]
    changed = true
  }
  for (const row of Object.values(d.seen)) if (oldKey in row) {
    row[newKey] = row[oldKey]
    delete row[oldKey]
    changed = true
  }
  return changed
}

export function adjacency(d: PeerData): Record<string, string[]> {
  const out: Record<string, Set<string>> = {}
  for (const [a, b] of d.edges) {
    ;(out[a] ??= new Set()).add(b)
    ;(out[b] ??= new Set()).add(a)
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]))
}

const isKey = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length < 200

/** A session-peers.json as read from disk: edges and seen cleaned; null when it is not the file. */
export function parsePeers(raw: unknown): PeerData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (o.version !== 1 || !Array.isArray(o.edges)) return null
  const d = emptyPeers()
  for (const e of o.edges) if (Array.isArray(e) && e.length === 2 && isKey(e[0]) && isKey(e[1]) && e[0] !== e[1] && !has(d, e[0], e[1])) d.edges.push(norm(e[0], e[1]))
  if (o.seen && typeof o.seen === 'object' && !Array.isArray(o.seen))
    for (const [t, row] of Object.entries(o.seen as Record<string, unknown>)) {
      if (!isKey(t) || !row || typeof row !== 'object' || Array.isArray(row)) continue
      d.seen[t] = {}
      for (const [p, at] of Object.entries(row as Record<string, unknown>)) if (isKey(p) && typeof at === 'number' && Number.isFinite(at)) d.seen[t][p] = at
    }
  return d
}
```

- [ ] **Step 4: Run tests**

Run: `cd app && npx vitest run src/shared/peers.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/peers.ts app/src/shared/peers.test.ts
git commit -m "feat(peers): pure graph for session-to-session links"
```

---

### Task 2: `PeerStore` and `AppState.peers`

**Files:**
- Create: `src/main/peers.ts`, `src/main/peers.test.ts`
- Modify: `src/shared/types.ts` (AppState), `src/main/sources.ts` (load store, expose, prune, carry), `src/web/preview/fixture.ts` (add `peers`)

**Interfaces:**
- Consumes: Task 1.
- Produces:
  ```ts
  // src/main/peers.ts
  export class PeerStore {
    constructor(file: string, now?: () => number)
    load(): void                                    // reads file; corrupt → moved aside, empty
    data(): PeerData                                // live object (do not mutate outside)
    of(key: string): string[]
    set(a: string, b: string, on: boolean): CliResult  // add/remove + save
    prune(live: Set<string>): string[]              // saves when something changed; returns dead keys
    carry(oldKey: string, newKey: string): void     // saves when changed
    markSeen(t: string, p: string, at: number): void // saves (coalesced: at most one write per 500 ms via a timer; flush() for tests)
    seen(t: string, p: string): number              // 0 when never
    expect(name: string, peers: string[]): void     // a session about to start by name
    claim(sessions: Pick<Session,'key'|'name'|'state'>[]): boolean // links expected sessions that showed up; expirations after 10 min; true when an edge was added
    onChange(cb: () => void): void                  // called after every save
    flush(): void
  }
  // Sources
  setPeerStore(store: PeerStore): void
  // AppState
  peers: Record<string, string[]>
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/peers.test.ts
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PeerStore } from './peers'

const dir = () => mkdtempSync(join(tmpdir(), 'peers-'))

describe('PeerStore', () => {
  it('round-trips edges and seen through the file', () => {
    const f = join(dir(), 'session-peers.json')
    const s = new PeerStore(f)
    s.load()
    expect(s.set('a', 'b', true)).toEqual({ ok: true, message: 'linked' })
    s.markSeen('a', 'b', 42)
    s.flush()
    const t = new PeerStore(f)
    t.load()
    expect(t.of('b')).toEqual(['a'])
    expect(t.seen('a', 'b')).toBe(42)
    expect(t.set('a', 'b', false)).toEqual({ ok: true, message: 'unlinked' })
    expect(t.of('a')).toEqual([])
  })
  it('moves a corrupt file aside and starts empty', () => {
    const d = dir()
    const f = join(d, 'session-peers.json')
    writeFileSync(f, '{not json')
    const s = new PeerStore(f)
    s.load()
    expect(s.of('a')).toEqual([])
    expect(readdirSync(d).some((n) => n.startsWith('session-peers.json.corrupt-'))).toBe(true)
  })
  it('prunes dead keys and reports them', () => {
    const s = new PeerStore(join(dir(), 'p.json'))
    s.load()
    s.set('a', 'b', true)
    expect(s.prune(new Set(['a']))).toEqual(['b'])
    expect(s.of('a')).toEqual([])
  })
  it('claims an expected session by name and expires old expectations', () => {
    let now = 1_000_000
    const s = new PeerStore(join(dir(), 'p.json'), () => now)
    s.load()
    s.expect('new-one', ['a', 'b'])
    expect(s.claim([{ key: 'a', name: 'a', state: 'idle' }])).toBe(false)
    expect(s.claim([{ key: 'n1', name: 'new-one', state: 'working' }, { key: 'a', name: 'a', state: 'idle' }])).toBe(true)
    expect(s.of('n1').sort()).toEqual(['a', 'b'])
    s.expect('late', ['a'])
    now += 11 * 60_000
    expect(s.claim([{ key: 'l1', name: 'late', state: 'idle' }])).toBe(false)
    expect(s.of('l1')).toEqual([])
  })
  it('calls onChange after a save', () => {
    const s = new PeerStore(join(dir(), 'p.json'))
    s.load()
    let n = 0
    s.onChange(() => n++)
    s.set('a', 'b', true)
    expect(n).toBe(1)
    expect(readFileSync(s.file, 'utf8')).toContain('"edges"')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd app && npx vitest run src/main/peers.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement `src/main/peers.ts`**

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CliResult, Session } from '@shared/types'
import { addEdge, carryKey, emptyPeers, parsePeers, peersOf, pruneEdges, removeEdge, type PeerData } from '@shared/peers'

const EXPECT_MS = 10 * 60_000
const SEEN_FLUSH_MS = 500

/** session-peers.json: which sessions are linked to which (Session.key), and what each has seen of its peers. */
export class PeerStore {
  private d: PeerData = emptyPeers()
  private pending = new Map<string, { peers: string[]; at: number }>()
  private listeners: (() => void)[] = []
  private seenTimer: NodeJS.Timeout | null = null

  constructor(readonly file: string, private readonly now: () => number = Date.now) {}

  load(): void {
    if (!existsSync(this.file)) return
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      raw = null
    }
    const d = parsePeers(raw)
    if (d) {
      this.d = d
      return
    }
    try {
      renameSync(this.file, `${this.file}.corrupt-${this.now()}`)
    } catch {
      // leave it; the next save overwrites
    }
    this.d = emptyPeers()
  }

  data(): PeerData {
    return this.d
  }
  of(key: string): string[] {
    return peersOf(this.d, key)
  }
  seen(t: string, p: string): number {
    return this.d.seen[t]?.[p] ?? 0
  }

  set(a: string, b: string, on: boolean): CliResult {
    if (on) {
      const r = addEdge(this.d, a, b)
      if (!r.ok) return r
      this.save()
      return { ok: true, message: 'linked' }
    }
    removeEdge(this.d, a, b)
    this.save()
    return { ok: true, message: 'unlinked' }
  }

  prune(live: Set<string>): string[] {
    const dead = pruneEdges(this.d, live)
    if (dead.length) this.save()
    return dead
  }

  carry(oldKey: string, newKey: string): void {
    if (carryKey(this.d, oldKey, newKey)) this.save()
  }

  markSeen(t: string, p: string, at: number): void {
    ;(this.d.seen[t] ??= {})[p] = at
    if (!this.seenTimer) this.seenTimer = setTimeout(() => this.flush(), SEEN_FLUSH_MS)
  }

  expect(name: string, peers: string[]): void {
    if (peers.length) this.pending.set(name, { peers, at: this.now() })
  }

  claim(sessions: Pick<Session, 'key' | 'name' | 'state'>[]): boolean {
    let changed = false
    const now = this.now()
    for (const [name, p] of this.pending) {
      const s = sessions.find((x) => x.name === name && x.state !== 'done')
      if (s) {
        this.pending.delete(name)
        for (const k of p.peers) if (addEdge(this.d, s.key, k).ok) changed = true
      } else if (now - p.at > EXPECT_MS) this.pending.delete(name)
    }
    if (changed) this.save()
    return changed
  }

  onChange(cb: () => void): void {
    this.listeners.push(cb)
  }

  flush(): void {
    if (this.seenTimer) {
      clearTimeout(this.seenTimer)
      this.seenTimer = null
    }
    this.write()
  }

  private save(): void {
    this.write()
    for (const cb of this.listeners) cb()
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error(`session peers: ${String(e)}`)
    }
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/main/peers.test.ts` PASS.

- [ ] **Step 5: Add `peers` to `AppState`**

In `src/shared/types.ts`, after `sessionPrs`:
```ts
  /** Sessions linked to each other ("Linked sessions"), by Session.key; symmetric, sorted. */
  peers: Record<string, string[]>;
```
Then `npm run typecheck` and fix every place that builds an `AppState` literal: `src/main/sources.ts` `build()` (add `peers: this.peerStore ? adjacency(this.peerStore.data()) : {}`), `src/web/preview/fixture.ts` (add `peers: { [SESSIONS[0].key]: [SESSIONS[1].key], [SESSIONS[1].key]: [SESSIONS[0].key] }` so `/?preview` shows a link), and any test helper that fails typecheck (`as AppState` casts need nothing).

- [ ] **Step 6: Wire the store into `Sources`**

In `src/main/sources.ts`:
- Field: `private peerStore: PeerStore | null = null;` and
  ```ts
  setPeerStore(store: PeerStore): void {
    this.peerStore = store;
    store.onChange(() => this.emit());
  }
  ```
- In `refreshAgents()` right after `this.carryLinks();`: 
  ```ts
  if (this.peerStore) {
    const live = new Set(this.rawSessions.filter((s) => s.state !== "done").map((s) => s.key));
    this.peerStore.prune(live);
    this.peerStore.claim(this.rawSessions);
  }
  ```
  (`emit()` is already coalesced; `onChange` triggers it when something changed.)
- In `noteCopy(old, copyBg)` after `carryCopy(...)` succeeds: `this.peerStore?.carry(old.bgId, copyBg);`
- `build()`: add the `peers` field (Step 5).

In `src/main/index.ts` next to `const deckHooks = new DeckHooks(...)`:
```ts
const peerStore = new PeerStore(join(paths.home, "session-peers.json"));
peerStore.load();
```
and after `sources` is constructed: `sources.setPeerStore(peerStore);`. Add `import { PeerStore } from "./peers";`.

- [ ] **Step 7: Typecheck + full tests**

Run: `cd app && npm run typecheck && npm test` — green.

- [ ] **Step 8: Commit**

```bash
git add app/src/main/peers.ts app/src/main/peers.test.ts app/src/shared/types.ts app/src/main/sources.ts app/src/main/index.ts app/src/web/preview/fixture.ts
git commit -m "feat(peers): PeerStore (session-peers.json) and AppState.peers"
```

---

### Task 3: IPC `peersSet` / `peersSync` end to end (handlers stubbed for sync)

**Files:**
- Modify: `src/shared/ipc.ts` (CH + DeckApi), `src/preload/index.ts`, `src/shared/remoteDeck.ts`, `src/main/index.ts`
- Test: `src/shared/remoteDeck.test.ts` (existing; must pass)

**Interfaces:**
- Produces:
  ```ts
  CH.peersSet = "peers:set";  CH.peersSync = "peers:sync";
  DeckApi.peersSet(a: string, b: string, on: boolean): Promise<CliResult>
  DeckApi.peersSync(sessionKey: string): Promise<CliResult>
  ```

- [ ] **Step 1: Add channels and API**

`src/shared/ipc.ts`: in `CH` after `linkSession`: `peersSet: "peers:set", peersSync: "peers:sync",`. In `DeckApi` after `linkSession(...)`:
```ts
  /** Link (on) or unlink (off) two sessions to each other (Session.key); two-way. */
  peersSet(a: string, b: string, on: boolean): Promise<CliResult>;
  /** Linked sessions → Sync now: summarize this session and refresh what its peers see. */
  peersSync(sessionKey: string): Promise<CliResult>;
```

- [ ] **Step 2: Preload + access**

`src/preload/index.ts` next to `linkSession`:
```ts
  peersSet: (a, b, on) => ipcRenderer.invoke(CH.peersSet, a, b, on),
  peersSync: (key) => ipcRenderer.invoke(CH.peersSync, key),
```
`src/shared/remoteDeck.ts` next to `linkSession`: `peersSet: invoke(CH.peersSet), peersSync: invoke(CH.peersSync),`.

- [ ] **Step 3: Handlers in `src/main/index.ts`** (next to `CH.linkSession`)

```ts
  reg.handle(CH.peersSet, (_e, a: unknown, b: unknown, on: unknown) => {
    if (typeof a !== "string" || typeof b !== "string" || a.length > 200 || b.length > 200) return { ok: false, message: "bad session" };
    const live = new Set((latest?.sessions ?? []).filter((s) => s.state !== "done").map((s) => s.key));
    if (on && (!live.has(a) || !live.has(b))) return { ok: false, message: "link running sessions only" };
    const r = peerStore.set(a, b, on === true);
    if (r.ok) peerSync.refreshAll([a, b]);   // Task 5; until then: `void r;`
    return r;
  });
  reg.handle(CH.peersSync, (_e, key: unknown) =>
    typeof key === "string" && key.length < 200 ? peerSync.syncNow(key) : { ok: false, message: "bad session" },
  );
```
Until Task 5 lands, make `peersSync` return `{ ok: false, message: "not yet" }` and leave `peersSet` without the `refreshAll` call; Task 5 replaces both lines.

- [ ] **Step 4: Verify**

Run: `cd app && npm run typecheck && npx vitest run src/shared/remoteDeck.test.ts src/main/ipcRegistry.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/shared/ipc.ts app/src/preload/index.ts app/src/shared/remoteDeck.ts app/src/main/index.ts
git commit -m "feat(peers): peersSet / peersSync IPC"
```

---

### Task 4: Context for peers — SessionStart block, start-prompt block, per-prompt delta in the hook

**Files:**
- Modify: `src/shared/deckHooks.ts` (`peersBlock`, `ticketContext` signature), `src/shared/deckHooks.test.ts`, `src/shared/prompt.ts` (`peersPromptBlock`), `src/shared/prompt.test.ts` (create if absent), `src/main/deckHooks.ts` (hook script: delta fast path; `setDelta`, `clearDelta`, `pruneDeltas`), `src/main/deckHooks.test.ts`, `src/main/sources.ts` (`writeTicketContext` → `writeSessionContext` with peers)

**Interfaces:**
- Produces:
  ```ts
  // shared/deckHooks.ts
  export interface PeerFact { key: string; name: string; cwd: string; branch: string | null; ticket: string | null; state: string; summary: { at: number; text: string } | null }
  export function peersBlock(peers: PeerFact[]): string   // '' when none; "## Linked sessions" + per peer
  export function ticketContext(ticket: {…} | null, earlier: {…}[], peers: PeerFact[] = []): object | null  // null when nothing to say
  export function peerDelta(p: PeerFact, now: number): object   // { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
  // shared/prompt.ts
  export function peersPromptBlock(peers: PeerFact[]): string   // same text as peersBlock, for composePrompt's `peers` arg
  composePrompt(system, instructions, description = '', earlier = '', setup = '', peers = '')
  // main/deckHooks.ts (DeckHooks)
  setDelta(sessionId: string, json: object): void    // writes deck/peers/<sid>.delta.json atomically (overwrites)
  clearDelta(sessionId: string): void
  pruneDeltas(live: Set<string>): void
  ```

- [ ] **Step 1: Failing tests for `peersBlock` / `ticketContext` / `peerDelta`**

Append to `src/shared/deckHooks.test.ts`:
```ts
import { peerDelta, peersBlock, ticketContext, type PeerFact } from './deckHooks'

const fact = (o: Partial<PeerFact>): PeerFact => ({ key: 'k', name: 'api-auth', cwd: '/w/acme/api', branch: 'feat/auth', ticket: 'acme/api#12', state: 'working', summary: null, ...o })

describe('peers context', () => {
  it('is empty with no peers', () => {
    expect(peersBlock([])).toBe('')
    expect(ticketContext(null, [], [])).toBeNull()
  })
  it('lists facts and "(no summary yet)"', () => {
    const b = peersBlock([fact({})])
    expect(b).toContain('## Linked sessions')
    expect(b).toContain('### api-auth')
    expect(b).toContain('acme/api#12')
    expect(b).toContain('feat/auth')
    expect(b).toContain('(no summary yet)')
  })
  it('orders newest summary first, caps at 5 peers and 2500 chars', () => {
    const list = Array.from({ length: 7 }, (_, i) => fact({ key: `k${i}`, name: `s${i}`, summary: { at: i, text: 'x'.repeat(3000) } }))
    const b = peersBlock(list)
    expect(b.indexOf('### s6')).toBeLessThan(b.indexOf('### s5'))
    expect(b).not.toContain('### s1')
    expect(b).toContain('x'.repeat(2500) + '…')
  })
  it('ticketContext keeps the ticket part and adds peers', () => {
    const c = ticketContext({ label: 'acme/web#3', title: 'T', url: null }, [], [fact({})]) as { hookSpecificOutput: { additionalContext: string } }
    expect(c.hookSpecificOutput.additionalContext).toContain('acme/web#3')
    expect(c.hookSpecificOutput.additionalContext).toContain('## Linked sessions')
    const noTicket = ticketContext(null, [], [fact({})]) as { hookSpecificOutput: { additionalContext: string } }
    expect(noTicket.hookSpecificOutput.additionalContext.startsWith('## Linked sessions')).toBe(true)
  })
  it('peerDelta names the session and the age', () => {
    const d = peerDelta(fact({ summary: { at: 1_000, text: '## Done\n- a' } }), 61_000) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } }
    expect(d.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(d.hookSpecificOutput.additionalContext).toContain('Linked session api-auth updated (1 min ago)')
    expect(d.hookSpecificOutput.additionalContext).toContain('- a')
  })
})
```

- [ ] **Step 2: Run** — `npx vitest run src/shared/deckHooks.test.ts` FAIL.

- [ ] **Step 3: Implement in `src/shared/deckHooks.ts`**

```ts
export interface PeerFact {
  key: string
  name: string
  cwd: string
  branch: string | null
  ticket: string | null
  state: string
  summary: { at: number; text: string } | null
}

/** "## Linked sessions": what this session's peers are doing, newest summary first (at most 5). */
export function peersBlock(peers: PeerFact[]): string {
  if (!peers.length) return ''
  const list = [...peers].sort((a, b) => (b.summary?.at ?? 0) - (a.summary?.at ?? 0)).slice(0, 5)
  const parts = ['## Linked sessions', 'Other MasterDeck sessions linked to this one. Use their context; do not edit their files unless asked.']
  for (const p of list) {
    const facts = [`folder ${p.cwd}`, p.branch ? `branch ${p.branch}` : null, p.ticket ? `ticket ${p.ticket}` : null, `state ${p.state}`].filter(Boolean).join(' · ')
    parts.push(`### ${p.name}\n${facts}\n\n${p.summary ? clip(p.summary.text.trim(), 2500) : '(no summary yet)'}`)
  }
  return parts.join('\n\n')
}

export function ticketContext(
  ticket: { label: string; title: string | null; url: string | null } | null,
  earlier: { name: string; at: number; text: string }[],
  peers: PeerFact[] = [],
): object | null {
  const parts: string[] = []
  if (ticket) {
    parts.push(`This session works on ${ticket.label}${ticket.title ? ` (${ticket.title})` : ''}.${ticket.url ? ` ${ticket.url}` : ''}`)
    if (earlier.length) { /* unchanged earlier block */ }
  }
  const pb = peersBlock(peers)
  if (pb) parts.push(pb)
  if (!parts.length) return null
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } }
}

const ago = (ms: number): string => (ms < 60_000 ? 'just now' : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`)

/** What a session is told on its next prompt when a linked session's summary changed. */
export function peerDelta(p: PeerFact, now: number): object {
  const text = `Linked session ${p.name} updated (${ago(now - (p.summary?.at ?? now))}):\n\n${p.summary ? clip(p.summary.text.trim(), 2500) : '(no summary yet)'}`
  return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
}
```
Keep the existing earlier-sessions code inside the `if (ticket)` branch exactly as it is. Update the one existing caller (`sources.ts writeTicketContext`) in Step 7 and any existing test that calls `ticketContext` with two args (still valid).

- [ ] **Step 4: `peersPromptBlock` in `src/shared/prompt.ts`**

```ts
import { peersBlock, type PeerFact } from './deckHooks'
export function peersPromptBlock(peers: PeerFact[]): string {
  return peersBlock(peers)
}
```
and in `composePrompt` add the `peers = ''` parameter; after the `past` block: `if (peers.trim()) parts.push(peers.trim())`. Add a test in `src/shared/prompt.test.ts` (create the file if it does not exist, same style as `peers.test.ts`):
```ts
it('adds the linked sessions block after the earlier-sessions block', () => {
  const p = composePrompt('SYS', '', '', 'EARLIER', '', '## Linked sessions\n\n### x')
  expect(p.indexOf('EARLIER')).toBeLessThan(p.indexOf('## Linked sessions'))
})
```

- [ ] **Step 5: Hook script delta fast path + `DeckHooks` delta files**

In `src/main/deckHooks.ts`, in the generated script's `UserPromptSubmit)` case, **before** the `/queue` fast path:
```sh
    # Linked sessions: a peer's summary changed since this session last heard (one file, read once).
    case "$sid" in *[!0-9a-fA-F-]*|'') ;; *)
      pd="$D/peers/$sid.delta.json"
      if [ -f "$pd" ] && mv "$pd" "$pd.read" 2>/dev/null; then cat "$pd.read"; rm -f "$pd.read"; exit 0; fi ;;
    esac
```
(Mind the template-literal escaping used by the rest of the script: `\\n` inside `printf`, `\${…}` for shell parameter expansion.) A UserPromptSubmit hook may print only one JSON; `exit 0` after the delta means a `/queue` typed in the same prompt is not handled that one time — acceptable and documented.

Add to class `DeckHooks` (next to `setContext`):
```ts
  /** What the next prompt of this session is told about a linked session (overwrites; read once by the hook). */
  setDelta(sessionId: string, json: object): void {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return
    const dir = join(this.dir, 'peers')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `${sessionId}.delta.json`)
    writeFileSync(`${p}.tmp`, JSON.stringify(json))
    renameSync(`${p}.tmp`, p)
  }
  clearDelta(sessionId: string): void {
    rm(join(this.dir, 'peers', `${sessionId}.delta.json`))
  }
  pruneDeltas(live: Set<string>): void {
    try {
      for (const n of readdirSync(join(this.dir, 'peers'))) if (n.endsWith('.delta.json') && !live.has(n.slice(0, -'.delta.json'.length))) rm(join(this.dir, 'peers', n))
    } catch {
      // none
    }
  }
```
Make sure `mkdirSync` of `peers/` also happens where `context/` is created at construction.

Test in `src/main/deckHooks.test.ts` (look at how existing tests run the generated script with `sh`; there is a helper that writes the script to a temp dir and runs an event with stdin JSON — reuse it):
```ts
it('UserPromptSubmit prints a peer delta once', () => {
  // arrange: write <dir>/peers/<sid>.delta.json with {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"hi"}}
  // act: run the script for UserPromptSubmit with {"session_id":"<sid>","prompt":"hello"}
  // assert: stdout parses to that JSON; file is gone; a second run prints nothing
})
```
Write it concretely against the existing helper; if there is none, spawn `sh <script> UserPromptSubmit` with `MASTERDECK_HOME`-style env the script reads (`$D`), as the existing Stop/queue tests do.

- [ ] **Step 6: Run** — `npx vitest run src/shared/deckHooks.test.ts src/shared/prompt.test.ts src/main/deckHooks.test.ts` PASS.

- [ ] **Step 7: `Sources.writeTicketContext` → includes peers, for every live session**

Rename nothing public. In `src/main/sources.ts` replace the body of `writeTicketContext(sessions)`:
- iterate every `s` with `s.state !== "done"`;
- ticket part only when `s.issue !== null` (as today);
- `const peers = this.peerFacts(s.key)`; skip the session entirely when `s.issue === null && !peers.length` (behaviour unchanged for unlinked ticketless sessions);
- `deck.setContext(s.sessionId, ticketContext(ticketOrNull, earlier, peers))` (`setContext` already accepts `null` → removes the file);
- after writing, `for (const p of peers) if (p.summary) this.peerStore?.markSeen(s.key, p.key, p.summary.at)`;
- keep `deck.pruneContext(live)` and add `deck.pruneDeltas(live)`.

Add:
```ts
  /** What this session's linked sessions are doing (facts + saved summary), by Session.key. */
  peerFacts(key: string): PeerFact[] {
    if (!this.peerStore) return [];
    const out: PeerFact[] = [];
    for (const pk of this.peerStore.of(key)) {
      const s = this.lastSessions.find((x) => x.key === pk);
      if (!s || s.state === "done") continue;
      const sum = this.summaryOf(s.sessionId);
      out.push({
        key: pk,
        name: s.name,
        cwd: this.lastStats?.[s.sessionId]?.currentDir ?? s.cwd,
        branch: this.lastGit?.[s.sessionId]?.branch ?? null,
        ticket: s.issue !== null ? ticketLabel(s.issueRepo, s.issue) : null,
        state: s.state,
        summary: sum,
      });
    }
    return out;
  }
```
Use whatever `Sources` already keeps for stats/git per session (look at how `build()` fills `stats` and `git`; name the fields it actually has). Also call `this.writeTicketContext(this.lastSessions)` from `setPeerStore`'s `onChange` callback so an edge change rewrites files immediately (keep the `emit()`).

- [ ] **Step 8: Typecheck + full suite**

`npm run typecheck && npm test` green.

- [ ] **Step 9: Commit**

```bash
git add app/src/shared/deckHooks.ts app/src/shared/deckHooks.test.ts app/src/shared/prompt.ts app/src/shared/prompt.test.ts app/src/main/deckHooks.ts app/src/main/deckHooks.test.ts app/src/main/sources.ts
git commit -m "feat(peers): linked sessions reach a session at SessionStart, on its next prompt, and in its first prompt"
```

---

### Task 5: `PeerSync` — automatic summaries on Stop, deltas, Sync now

**Files:**
- Create: `src/main/peerSync.ts`, `src/main/peerSync.test.ts`
- Modify: `src/main/sources.ts` (Stop callback), `src/main/index.ts` (construct, wire handlers from Task 3), `src/shared/send.ts` or `src/main/send.ts` (nothing new; reuse `Sender.send` + `canDeliver`)

**Interfaces:**
- Consumes: `PeerStore` (Task 2), `DeckHooks.setDelta/clearDelta` and `Sources.peerFacts` (Task 4), `Summaries.make/get`, `Sender.send`, `canDeliver`.
- Produces:
  ```ts
  export const PEER_SYNC_MIN_MS = 120_000
  export interface PeerSyncDeps {
    store: PeerStore
    sessions: () => Session[]                                   // latest live sessions
    facts: (key: string) => PeerFact[]                          // sources.peerFacts
    summaryStale: (key: string) => boolean                      // same rule as CH.summaryGet
    makeSummary: (key: string) => Promise<{ ok: true; summary: { at: number } } | { ok: false; message: string }>
    setDelta: (sessionId: string, json: object) => void
    clearDelta: (sessionId: string) => void
    rewriteContext: () => void                                  // sources.writeTicketContext(lastSessions)
    hooksLive: () => boolean                                    // false on win32 / hooks not installed
    deliver: (s: Session, text: string) => Promise<CliResult>   // Sender fallback
    now?: () => number
    auto?: () => boolean                                        // config peerSync.auto, default true
  }
  export class PeerSync {
    constructor(deps: PeerSyncDeps)
    onStop(sessionId: string): void          // from Sources when a Stop event arrives
    refreshAll(keys: string[]): void         // rewrite context + deltas for these sessions' peers (after link/unlink)
    syncNow(key: string): Promise<CliResult> // ignore debounce; make summary; refresh; Sender fallback when !hooksLive
  }
  ```
- `Sources.onSessionStop(cb: (sessionId: string) => void): void` — called from `pollDeck()` for each sid in `deck.readEvents()` whose `deck.sessions[sid]?.stoppedAt` is newer than the last one seen for that sid.

- [ ] **Step 1: Failing tests `src/main/peerSync.test.ts`**

```ts
import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PEER_SYNC_MIN_MS, PeerSync, type PeerSyncDeps } from './peerSync'
import { PeerStore } from './peers'
import type { Session } from '@shared/types'

const sess = (key: string, over: Partial<Session> = {}): Session => ({ key, sessionId: `${key}-sid`, name: key, kind: 'background', bgId: key, pid: 1, cwd: '/w', state: 'idle', rawState: 'idle', startedAt: 0, issue: null, ...over })

function rig(over: Partial<PeerSyncDeps> = {}) {
  let now = 1_000_000
  const store = new PeerStore(join(mkdtempSync(join(tmpdir(), 'ps-')), 'p.json'), () => now)
  store.load()
  const sessions = [sess('a'), sess('b'), sess('c')]
  const summaries: Record<string, { at: number; text: string }> = {}
  const deps: PeerSyncDeps = {
    store,
    sessions: () => sessions,
    facts: (k) => store.of(k).map((p) => ({ key: p, name: p, cwd: '/w', branch: null, ticket: null, state: 'idle', summary: summaries[p] ?? null })),
    summaryStale: vi.fn(() => true),
    makeSummary: vi.fn(async (k: string) => { summaries[k] = { at: now, text: `sum ${k} ${now}` }; return { ok: true as const, summary: { at: now } } }),
    setDelta: vi.fn(),
    clearDelta: vi.fn(),
    rewriteContext: vi.fn(),
    hooksLive: () => true,
    deliver: vi.fn(async () => ({ ok: true, message: 'sent' })),
    now: () => now,
    ...over,
  }
  const sync = new PeerSync(deps)
  return { sync, deps, store, sessions, summaries, tick: (ms: number) => (now += ms) }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('PeerSync', () => {
  it('does nothing on Stop for a session without peers', async () => {
    const r = rig()
    r.sync.onStop('a-sid')
    await flush()
    expect(r.deps.makeSummary).not.toHaveBeenCalled()
    expect(r.deps.setDelta).not.toHaveBeenCalled()
  })
  it('summarizes a linked session on Stop and writes a delta for each unseen peer', async () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.store.set('a', 'c', true)
    r.sync.onStop('a-sid')
    await flush()
    expect(r.deps.makeSummary).toHaveBeenCalledWith('a')
    expect(r.deps.setDelta).toHaveBeenCalledTimes(2)
    expect(r.deps.setDelta).toHaveBeenCalledWith('b-sid', expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ hookEventName: 'UserPromptSubmit' }) }))
    expect(r.deps.rewriteContext).toHaveBeenCalled()
    expect(r.store.seen('b', 'a')).toBe(r.summaries.a.at)
  })
  it('debounces: a second Stop within PEER_SYNC_MIN_MS makes no summary', async () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    r.tick(PEER_SYNC_MIN_MS - 1)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).toHaveBeenCalledTimes(1)
    r.tick(2)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).toHaveBeenCalledTimes(2)
  })
  it('skips when the summary is not stale', async () => {
    const r = rig({ summaryStale: () => false })
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).not.toHaveBeenCalled()
  })
  it('writes no second delta when the peer already saw that summary', async () => {
    const r = rig()
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    r.sync.refreshAll(['a'])
    expect(r.deps.setDelta).toHaveBeenCalledTimes(1)
  })
  it('syncNow ignores the debounce and uses Sender when hooks are not live', async () => {
    const r = rig({ hooksLive: () => false })
    r.store.set('a', 'b', true)
    expect((await r.sync.syncNow('a')).ok).toBe(true)
    expect((await r.sync.syncNow('a')).ok).toBe(true)
    expect(r.deps.makeSummary).toHaveBeenCalledTimes(2)
    expect(r.deps.deliver).toHaveBeenCalledWith(expect.objectContaining({ key: 'b' }), expect.stringContaining('Linked session a updated'))
    expect(r.deps.setDelta).not.toHaveBeenCalled()
  })
  it('syncNow refuses an unlinked or unknown session', async () => {
    const r = rig()
    expect((await r.sync.syncNow('a')).ok).toBe(false)
    expect((await r.sync.syncNow('zz')).ok).toBe(false)
  })
  it('auto off: Stop does nothing, syncNow still works', async () => {
    const r = rig({ auto: () => false })
    r.store.set('a', 'b', true)
    r.sync.onStop('a-sid'); await flush()
    expect(r.deps.makeSummary).not.toHaveBeenCalled()
    expect((await r.sync.syncNow('a')).ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run** — FAIL, module not found.

- [ ] **Step 3: Implement `src/main/peerSync.ts`**

```ts
import type { CliResult, Session } from '@shared/types'
import { peerDelta, type PeerFact } from '@shared/deckHooks'
import { canDeliver } from '@shared/watches'
import type { PeerStore } from './peers'

export const PEER_SYNC_MIN_MS = 120_000

export interface PeerSyncDeps { /* as in Interfaces */ }

/** Keeps linked sessions' summaries fresh and tells each session when a peer's summary changed. */
export class PeerSync {
  private lastMake = new Map<string, number>()
  private inFlight = new Set<string>()
  private again = new Set<string>()
  constructor(private readonly deps: PeerSyncDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }
  private byId(sessionId: string): Session | undefined { return this.deps.sessions().find((s) => s.sessionId === sessionId) }
  private byKey(key: string): Session | undefined { return this.deps.sessions().find((s) => s.key === key) }

  onStop(sessionId: string): void {
    if (this.deps.auto && !this.deps.auto()) return
    const s = this.byId(sessionId)
    if (!s || s.state === 'done' || !this.deps.store.of(s.key).length) return
    if (this.now() - (this.lastMake.get(s.key) ?? 0) < PEER_SYNC_MIN_MS) return
    if (!this.deps.summaryStale(s.key)) return
    void this.make(s.key)
  }

  private async make(key: string): Promise<CliResult> {
    if (this.inFlight.has(key)) { this.again.add(key); return { ok: true, message: 'already summarizing' } }
    this.inFlight.add(key)
    this.lastMake.set(key, this.now())
    try {
      const r = await this.deps.makeSummary(key)
      if (!r.ok) return r
      this.refreshAll([key])
      return { ok: true, message: 'synced' }
    } finally {
      this.inFlight.delete(key)
      if (this.again.delete(key)) void this.make(key)
    }
  }

  /** After a summary or link change for `keys`: rewrite every context file, then a delta per peer that has not seen the newest summary. */
  refreshAll(keys: string[]): void {
    this.deps.rewriteContext()
    for (const key of keys) {
      const me = this.byKey(key)
      if (!me) continue
      for (const peerKey of this.deps.store.of(key)) {
        const peer = this.byKey(peerKey)
        if (!peer || peer.state === 'done') continue
        const fact = this.deps.facts(peerKey).find((f) => f.key === key)   // how `key` looks to `peer`
        if (!fact?.summary) continue
        if (this.deps.store.seen(peerKey, key) >= fact.summary.at) continue
        if (this.deps.hooksLive()) this.deps.setDelta(peer.sessionId, peerDelta(fact, this.now()))
        this.deps.store.markSeen(peerKey, key, fact.summary.at)
      }
    }
  }

  async syncNow(key: string): Promise<CliResult> {
    const s = this.byKey(key)
    if (!s) return { ok: false, message: 'session not found' }
    const peers = this.deps.store.of(key)
    if (!peers.length) return { ok: false, message: 'no linked sessions' }
    this.lastMake.delete(key)
    const r = await this.make(key)
    if (!r.ok) return r
    if (!this.deps.hooksLive()) {
      const fact = (pk: string) => this.deps.facts(pk).find((f) => f.key === key)
      for (const pk of peers) {
        const peer = this.byKey(pk)
        const f = fact(pk)
        if (!peer || !f?.summary || !canDeliver(peer)) continue
        const text = (peerDelta(f, this.now()) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
        await this.deps.deliver(peer, text)
      }
    }
    return { ok: true, message: 'synced' }
  }
}
```
Note on `refreshAll` in the Sender-fallback case: with `hooksLive() === false` it still marks `seen`, so `syncNow` must compute deliveries **before** `make()`'s `refreshAll` marks them — simplest: in `syncNow`, when `!hooksLive()`, snapshot `unseen = peers.filter(pk => store.seen(pk, key) < (facts(pk).find(..)?.summary?.at ?? 0))` *after* `make()` but have `refreshAll` skip `markSeen` when `!hooksLive()`; then `syncNow` marks seen after `deliver` succeeds. Implement it that way and keep the test above passing.

- [ ] **Step 4: `Sources.onSessionStop`**

In `src/main/sources.ts`: `private stopListeners: ((sid: string) => void)[] = []; private lastStopAt: Record<string, number> = {};` and
```ts
  onSessionStop(cb: (sessionId: string) => void): void { this.stopListeners.push(cb); }
```
In `pollDeck()` inside `for (const sid of deck.readEvents())`:
```ts
      const st = deck.sessions[sid]?.stoppedAt ?? null;
      if (st && st !== this.lastStopAt[sid]) {
        this.lastStopAt[sid] = st;
        for (const cb of this.stopListeners) cb(sid);
      }
```
Also expose `rewriteSessionContext(): void { this.writeTicketContext(this.lastSessions); }` (public) for `PeerSync.rewriteContext`.

- [ ] **Step 5: Wire in `src/main/index.ts`**

After `sources`, `summaries`, `sender`, `peerStore` exist:
```ts
const peerSync = new PeerSync({
  store: peerStore,
  sessions: () => latest?.sessions ?? [],
  facts: (k) => sources.peerFacts(k),
  summaryStale: (key) => {
    const s = latest?.sessions.find((x) => x.key === key);
    if (!s) return false;
    const summary = summaries.get(s.sessionId);
    const t = sources.sessionFacts(s.sessionId, s.key).transcript;
    const size = t && existsSync(t) ? statSync(t).size : 0;
    return !summary || size > summary.size;
  },
  makeSummary: async (key) => { /* same body as the CH.summaryMake handler; extract that body into `makeSummaryFor(key)` and call it from both */ },
  setDelta: (sid, json) => deckHooks.setDelta(sid, json),
  clearDelta: (sid) => deckHooks.clearDelta(sid),
  rewriteContext: () => sources.rewriteSessionContext(),
  hooksLive: () => process.platform !== "win32" && deckHooksInstalled(),   // find the existing "are deck hooks installed" check used at startup near installDeckHooks (index.ts ~3147) and reuse it
  deliver: (s, text) => sender.send(s, text, sendMasterUp(true, latest?.master.kind)),
  auto: () => getConfig().peerSync?.auto !== false,   // add `peerSync?: { auto?: boolean }` to the config type where `getConfig()`'s shape is defined (shared/config.ts or similar); no UI for it
});
sources.onSessionStop((sid) => peerSync.onStop(sid));
```
Replace the two placeholder lines from Task 3 with `peerSync.refreshAll([a, b])` and `peerSync.syncNow(key)`. On `peersSet(..., false)` also `deckHooks.clearDelta` for both sessions' ids when they have no other peers (look them up in `latest.sessions`).

- [ ] **Step 6: Run** — `npx vitest run src/main/peerSync.test.ts && npm run typecheck && npm test` PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/main/peerSync.ts app/src/main/peerSync.test.ts app/src/main/sources.ts app/src/main/index.ts app/src/shared
git commit -m "feat(peers): PeerSync — summaries on Stop, per-prompt deltas, Sync now"
```

---

### Task 6: Details panel — "Linked sessions" section and picker

**Files:**
- Create: `src/renderer/src/components/PeersDialog.tsx`, `src/renderer/src/components/peersView.ts` (+ `peersView.test.ts`)
- Modify: `src/renderer/src/components/SessionDetails.tsx`, `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `state.peers`, `deck().peersSet`, `deck().peersSync`, `suggestSessions`/`resolveSession` (`shared/link.ts`), `can()` web gating (see how `can("notesList")` is used in SessionDetails).
- Produces:
  ```ts
  // peersView.ts (pure, testable)
  export function peerRows(state: AppState, key: string): { key: string; name: string; state: SessionState; folder: string; ticket: string | null }[]
  export function linkable(state: AppState, key: string, text: string): Session[]  // suggestSessions minus self, done, already linked
  ```

- [ ] **Step 1: Failing test `peersView.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import type { AppState, Session } from '@shared/types'
import { linkable, peerRows } from './peersView'

const sess = (key: string, over: Partial<Session> = {}): Session => ({ key, sessionId: `${key}-sid`, name: key, kind: 'background', bgId: key, pid: 1, cwd: `/w/${key}`, state: 'idle', rawState: 'idle', startedAt: 0, issue: null, ...over })
const state = (over: Partial<AppState>): AppState => ({ sessions: [], peers: {}, stats: {}, ...over } as unknown as AppState)

describe('peersView', () => {
  it('rows show the peers with folder basename and ticket', () => {
    const st = state({ sessions: [sess('a'), sess('b', { issue: 7, issueRepo: 'acme/web', state: 'working' })], peers: { a: ['b'], b: ['a'] } })
    expect(peerRows(st, 'a')).toEqual([{ key: 'b', name: 'b', state: 'working', folder: 'b', ticket: 'acme/web#7' }])
    expect(peerRows(st, 'zz')).toEqual([])
  })
  it('linkable excludes self, done and already linked', () => {
    const st = state({ sessions: [sess('a'), sess('b'), sess('c', { state: 'done' }), sess('d')], peers: { a: ['b'], b: ['a'] } })
    expect(linkable(st, 'a', '').map((s) => s.key)).toEqual(['d'])
  })
})
```

- [ ] **Step 2: Implement `peersView.ts`** using `ticketLabel` from `@shared/ticketLinks` (or wherever `ticketLabel` lives — grep SessionDetails imports) and `suggestSessions` from `@shared/link`; folder = last path segment of `state.stats[sessionId]?.currentDir ?? cwd`.

- [ ] **Step 3: `PeersDialog.tsx`**

Copy the structure of `LinkDialog.tsx` (backdrop, dialog, input with suggestions, Escape closes). Props: `{ state: AppState; session: Session; onClose: () => void }`. Typing filters `linkable(state, session.key, text)`; clicking a suggestion calls `deck().peersSet(session.key, pick.key, true)`; shows `r.message` on failure (e.g. the 8 cap). Title "Link sessions", kind badge `LINK`. Header line: "Linked sessions see each other's summary."

- [ ] **Step 4: Section in `SessionDetails.tsx`**

After the Ticket `<section>`:
```tsx
      {(peers.length > 0 || peersOpen) && (
        <section className="dsec">
          <div className="eyebrow">Linked sessions</div>
          {peers.map((p) => (
            <div key={p.key} className="d-peer">
              <i className={`dot st-${p.state}`} />
              <span className="d-peer-name">{p.name}</span>
              <span className="muted"> {p.folder}{p.ticket ? ` · ${p.ticket}` : ""}</span>
              {can("peersSet") && (
                <button className="d-x" title="Unlink" onClick={async () => { const r = await deck().peersSet(s.key, p.key, false); if (!r.ok) flash(r.message); }}>×</button>
              )}
            </div>
          ))}
          <div className="d-actions-inline">
            {can("peersSet") && <button className="d-link" onClick={() => setPeersOpen(true)}>Add…</button>}
            {peers.length > 0 && can("peersSync") && (
              <button className="d-link" disabled={syncing} onClick={async () => { setSyncing(true); const r = await deck().peersSync(s.key); setSyncing(false); flash(r.ok ? "Synced" : r.message); }}>
                {syncing ? "Syncing…" : "Sync now"}
              </button>
            )}
          </div>
        </section>
      )}
```
with `const peers = peerRows(state, s.key)`, `const [peersOpen, setPeersOpen] = useState(false)`, `const [syncing, setSyncing] = useState(false)`, and `{peersOpen && <PeersDialog state={state} session={s} onClose={() => setPeersOpen(false)} />}` rendered at the end. In the actions row (next to "Close terminal"), when `peers.length === 0`: `<button className="btn" onClick={() => setPeersOpen(true)}>Link sessions…</button>`. Reuse the state-dot class the session list already uses (grep `st-` in styles.css; if the dot class is different, use that one).

- [ ] **Step 5: CSS** in `styles.css`: `.d-peer { display:flex; align-items:center; gap:6px; }`, `.d-peer-name { font-weight:500 }`, `.d-x { margin-left:auto; background:none; border:0; color:var(--muted); cursor:pointer }`, `.d-actions-inline { display:flex; gap:12px; margin-top:4px }` — match neighbouring `.d-*` rules.

- [ ] **Step 6: Verify** — `npx vitest run src/renderer/src/components/peersView.test.ts && npm run typecheck`. Then `npm run dev` is not needed for the gate; the preview fixture (`/?preview`) must show the linked pair (checked in Task 8's screenshots).

- [ ] **Step 7: Commit**

```bash
git add app/src/renderer/src/components/PeersDialog.tsx app/src/renderer/src/components/peersView.ts app/src/renderer/src/components/peersView.test.ts app/src/renderer/src/components/SessionDetails.tsx app/src/renderer/src/styles.css
git commit -m "feat(peers): Linked sessions section in the details panel"
```

---

### Task 7: Start dialogs — "Link to sessions" field

**Files:**
- Create: `src/renderer/src/components/PeerPicker.tsx` (multi-select chips, reused by both dialogs)
- Modify: `src/renderer/src/components/AssignDialog.tsx`, `src/renderer/src/components/NewMenu.tsx` (`NewSessionReq.peers`), `src/shared/ipc.ts` (`AssignRequest.peers`, `startClaude` req `peers`), `src/main/index.ts` (`CH.assign` and `CH.startClaude`: `peerStore.expect(name, peers)`; `peers` validated as string[] of live keys, ≤ 8), `src/main/assign.ts` (nothing: `AssignRequest` passes through), `src/shared/prompt.ts` already has the `peers` arg

**Interfaces:**
- Produces: `AssignRequest.peers?: string[]`, `NewSessionReq.peers?: string[]`, `<PeerPicker state value onChange exclude? />`.

- [ ] **Step 1: `PeerPicker.tsx`**

Controlled component: `{ state: AppState; value: string[]; onChange: (keys: string[]) => void }`. Renders chips for chosen keys (name + ×) and an input; typing shows up to 8 `suggestSessions(text, candidates)` where candidates = live sessions (`state !== 'done'`) not already chosen; Enter/click adds; refuses beyond `MAX_PEERS` with a hint. Label "Link to sessions", helper "They will see this session's summary, and it theirs."

- [ ] **Step 2: AssignDialog**

In "Where it runs" after the name/account grid: `<PeerPicker state={state} value={peers} onChange={setPeers} />` with `const [peers, setPeers] = useState<string[]>([])`. In `start()`: add `...(peers.length ? { peers } : {})` to the `onStart({...})` object, and pass `peersPromptBlock(factsFor(peers))` as the sixth `composePrompt` argument where `factsFor` builds `PeerFact[]` from `state` (`name`, `cwd`, `branch: state.git[sessionId]?.branch ?? null`, ticket, state, `summary: null` — the renderer has no summaries; the SessionStart file brings them at first turn end anyway).

- [ ] **Step 3: NewSessionDialog** (`NewMenu.tsx`)

Add the same picker below the Name field; `NewSessionReq.peers?: string[]`; include in `onStart({...})`. The ticketless prompt is raw: append `\n\n` + `peersPromptBlock(...)` to `prompt` when peers are chosen and a prompt is given; with no prompt, still send `peers` (context arrives through SessionStart).

- [ ] **Step 4: Main**

`src/shared/ipc.ts`: `AssignRequest.peers?: string[]` ("Session keys to link the new session to (two-way)"); `startClaude` req gets `peers?: string[]`. In `index.ts` `CH.assign` handler before `assignNow(req)`:
```ts
    const peers = livePeerKeys(given?.peers);   // helper: Array.isArray → strings → ∈ live keys → unique → slice(0, MAX_PEERS)
    if (peers.length && typeof req.name === "string") peerStore.expect(req.name, peers);
```
Same in `CH.startClaude` after the name is validated. `livePeerKeys` lives in `index.ts` next to the handlers (uses `latest?.sessions`).

- [ ] **Step 5: Verify** — `npm run typecheck && npm test` green. Manual: `npm run dev`, open Start dialog on a ticket, pick a running session, start; the details panel of the new session lists it within ~3 s (claim on the next agents poll).

- [ ] **Step 6: Commit**

```bash
git add app/src/renderer/src/components/PeerPicker.tsx app/src/renderer/src/components/AssignDialog.tsx app/src/renderer/src/components/NewMenu.tsx app/src/shared/ipc.ts app/src/main/index.ts
git commit -m "feat(peers): Link to sessions in both Start dialogs"
```

---

### Task 8: Docs

**Files:**
- Modify: `docs/ARCHITECTURE.md` (files-on-disk table: `session-peers.json`, `deck/peers/*.delta.json`; AppState `peers`; hooks: UserPromptSubmit delta; `PeerSync`), `docs/GUIDE.md` (section "Linked sessions": link at start / in details, what peers see, Sync now, unlink, Windows note), `docs/TODO.md` (Done: #67 with the commit; Open: "Sync now typed delivery only covers idle peers", "`/queue` typed on the same prompt as a pending delta is not handled that once").

- [ ] **Step 1: Write the three doc edits** in the voice of the surrounding text (short, factual, file names in backticks).
- [ ] **Step 2: Commit**

```bash
git add docs/ARCHITECTURE.md docs/GUIDE.md docs/TODO.md
git commit -m "docs: linked sessions (#67)"
```

---

## Self-review notes

- Spec coverage: data model (T1, T2), UI start (T7), UI details (T6), IPC (T3), sharing: SessionStart (T4), delta (T4+T5), start prompt (T4+T7), Sync now + fallback (T5), unlink/prune (T2, T5), docs (T8). Config switch `peerSync.auto` (T5). Cross-account/repo: no restriction anywhere — satisfied by construction.
- Names consistent: `peersSet/peersSync`, `PeerStore.set/of/prune/carry/markSeen/seen/expect/claim`, `PeerFact`, `peersBlock`, `peerDelta`, `peersPromptBlock`, `PeerSync.onStop/refreshAll/syncNow`, `Sources.peerFacts/onSessionStop/rewriteSessionContext/setPeerStore`.
