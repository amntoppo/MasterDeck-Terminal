/**
 * The wire contract between MasterDeck, this backend and its clients. MasterDeck keeps a copy of
 * this file (app/src/shared/remote.ts); change both together and bump PROTOCOL_VERSION when an old
 * desktop could no longer talk to a new server.
 * PROTOCOL_VERSION 3 adds browsers; the hub still accepts MIN_PROTOCOL desktops.
 */
import { z } from 'zod'

export const PROTOCOL_VERSION = 3
export const MIN_PROTOCOL = 2
export const MAX_TEXT = 10_000
export const MAX_FRAME = 1_400_000

const id = z.string().min(1).max(300)
const key = z.string().min(1).max(200)
const text = z.string().max(MAX_TEXT)
/** An end-to-end encrypted frame between a browser and the Mac: opaque to the server. */
const frameData = z.string().max(MAX_FRAME)
const browserId = z.string().min(1).max(100)
/** A P-256 public key: base64url of the 65-byte uncompressed point. */
export const PUBKEY_RE = /^B[A-Za-z0-9_-]{86}$/
/** A 16-byte approval nonce, base64url. */
export const NONCE_RE = /^[A-Za-z0-9_-]{22}$/

/** C0/C1 control characters except newline and tab: a terminal would act on them. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
const noControl = (s: string) => !CONTROL.test(s)
const NO_CONTROL = { message: 'may not contain control characters' }

/** Free text that is stored or typed, never a command: control characters refused. */
export const clean = (max: number) => z.string().max(max).refine(noControl, NO_CONTROL)

/** Text that reaches a session: no slash commands, no shell escapes, no control characters. */
export const noEscape = text.refine((s) => !/^\s*[/!]/.test(s), { message: 'may not start with / or !' }).refine(noControl, NO_CONTROL)

export const INBOX_ACTIONS = ['reply', 'option', 'menu', 'continue', 'compact', 'approve', 'reject', 'send'] as const

/** The shapes MasterDeck's answerMenu takes. */
const MenuAnswer = z.union([
  z.literal('submit'),
  z.strictObject({ picks: z.array(z.number().int().min(0).max(20)).max(20), text: noEscape.max(2000).optional() }),
  z.strictObject({
    answers: z.record(z.string().max(500), noEscape.max(2000)).refine((o) => Object.keys(o).length <= 20, { message: 'at most 20 answers' }),
  }),
])

const QueueEdit = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), text: noEscape.min(1) }),
  z.object({ op: z.literal('remove'), index: z.number().int().min(0), text }),
  z.object({ op: z.literal('move'), index: z.number().int().min(0), text, to: z.number().int().min(0) }),
  z.object({ op: z.literal('clear') }),
])

export const CommandInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('inbox.act'),
    itemId: id,
    args: z.strictObject({
      action: z.enum(INBOX_ACTIONS),
      text: noEscape.optional(),
      /** The option's key for `option` ("B"): 1-3 letters or digits, so it can never start a command. */
      key: z.string().regex(/^[A-Za-z0-9]{1,3}$/).optional(),
      /** For `menu`: the question being answered and the answer, as MasterDeck's answerMenu takes them. */
      question: z.string().max(2000).nullable().optional(),
      answer: MenuAnswer.optional(),
    }),
  }),
  z.object({ type: z.literal('inbox.snooze'), itemId: id, args: z.strictObject({ minutes: z.number().int().min(1).max(7 * 24 * 60) }) }),
  z.object({ type: z.literal('inbox.dismiss'), itemId: id, args: z.strictObject({}).default({}) }),
  z.object({
    type: z.literal('session.start'),
    args: z.strictObject({
      issue: z.number().int().positive(),
      repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/).nullable().optional(),
      model: z.string().regex(/^[A-Za-z0-9.[\]_-]{1,60}$/).optional(),
      prompt: noEscape.optional(),
    }),
  }),
  z.object({ type: z.literal('session.stop'), args: z.strictObject({ key }) }),
  z.object({ type: z.literal('session.resume'), args: z.strictObject({ key }) }),
  z.object({
    type: z.literal('session.send'),
    args: z.strictObject({ key, text: noEscape.min(1), via: z.enum(['queue', 'now']).default('queue') }),
  }),
  z.object({ type: z.literal('queue.edit'), args: z.strictObject({ key, edit: QueueEdit }) }),
  z.object({ type: z.literal('session.setStatus'), args: z.strictObject({ key, status: z.string().max(40).nullable() }) }),
])
export type CommandInput = z.infer<typeof CommandInput>
export type CommandType = CommandInput['type']

export type Command = CommandInput & { id: string; createdAt: number; by: string }
export type CommandStatus = 'queued' | 'sent' | 'done' | 'failed' | 'stale' | 'cancelled'
export interface CommandResult {
  ok: boolean
  message: string
  data?: unknown
}
export interface CommandRecord {
  cmd: Command
  status: CommandStatus
  sentAt: number | null
  doneAt: number | null
  result: CommandResult | null
}

export const ItemInput = z
  .object({
    title: clean(200).min(1),
    body: z.string().max(MAX_TEXT).default(''),
    options: z.array(clean(200).min(1)).min(1).max(10).optional(),
    allowText: z.boolean().default(true),
    sessionKey: key.optional(),
    ticket: z.string().max(200).optional(),
    priority: z.number().int().min(0).max(100).default(85),
    callbackUrl: z.url({ protocol: /^https$/ }).max(2000).optional(),
  })
  .refine((i) => i.allowText || (i.options?.length ?? 0) > 0, { message: 'give options, or allow a text answer' })
export type ItemInput = z.infer<typeof ItemInput>

export const ItemAnswer = z.object({ answer: clean(MAX_TEXT).min(1) })

export type ItemState = 'open' | 'answered' | 'dismissed'
export type CallbackStatus = 'none' | 'pending' | 'delivered' | 'failed'
export interface ExternalItem extends ItemInput {
  id: string
  createdAt: number
  by: string
  state: ItemState
  answer: string | null
  answeredBy: string | null
  answeredAt: number | null
  callbackStatus: CallbackStatus
  callbackAttempts: number
}

// ---- The snapshot MasterDeck sends (the Tasks view and Needs you) ----

export interface RemoteSession {
  key: string
  sessionId: string
  name: string
  kind: 'background' | 'interactive'
  state: string
  waitingOn: string | null
  busyWith: string | null
  asking: string | null
  issue: number | null
  issueRepo: string | null
  startedAt: number
  costUsd: number | null
  contextPct: number | null
  prUrls: string[]
  schedules: { id: string; name: string; when: string; nextAt: number | null }[]
  monitors: { id: string; description: string; events: number; lastEventAt: number | null }[]
}

export interface RemoteInboxEntry {
  id: string
  kind: string
  priority: number
  sessionKey: string | null
  ticket: string | null
  title: string
  body: string
  actions: { type: string; label: string; primary?: boolean }[]
  state: 'open' | 'snoozed' | 'dismissed' | 'resolved'
  firstSeen: number
  snoozedUntil: number | null
  resolvedAt: number | null
  resolvedHow: string | null
}

export interface RemoteCard {
  number: number
  repo: string | null
  project: string | null
  title: string
  url: string
  status: string | null
  assignees: string[]
  labels: string[]
  prUrls: string[]
}

export interface RemoteSnapshot {
  takenAt: number
  appVersion: string
  me: string | null
  master: 'attached' | 'elsewhere' | 'duplicate' | 'absent'
  sessions: RemoteSession[]
  inbox: { open: RemoteInboxEntry[]; snoozed: RemoteInboxEntry[]; history: RemoteInboxEntry[] }
  /** The menu on a session's screen, by session key (for answering `menu` items). */
  menus: Record<string, unknown>
  board: { columns: string[]; sprint: string | null; cards: RemoteCard[] } | null
  proposals: { id: number; kind: string; issue: number; repo: string | null; status: string; summary: string }[]
  prLive: Record<string, { number: number; title: string | null; state: string; ci: string | null; reviewDecision: string | null; isDraft: boolean }>
}

// ---- Messages ----

export const DesktopMsg = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    deviceId: z.string().min(1).max(100),
    appVersion: z.string().max(40),
    protocol: z.number().int(),
    macPublicKey: z.string().regex(PUBKEY_RE).optional(),
  }),
  z.object({ t: z.literal('snapshot'), data: z.record(z.string(), z.unknown()) }),
  /** JSON Patch against the server's stored snapshot at version `base`; answered by snapshotAck or snapshotNeeded. */
  z.object({
    t: z.literal('snapshotPatch'),
    base: z.number().int().min(1),
    ops: z
      .array(
        z.object({
          op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
          path: z.string().max(1000).regex(/^(\/.*)?$/s),
          value: z.unknown().optional(),
          from: z.string().optional(),
        }),
      )
      .max(2000),
  }),
  z.object({
    t: z.literal('result'),
    cmdId: z.string().min(1).max(100),
    ok: z.boolean(),
    status: z.literal('stale').optional(),
    message: z.string().max(2000),
    data: z.unknown().optional(),
  }),
  z.object({ t: z.literal('itemAnswered'), itemId: z.string().min(1).max(100), answer: clean(MAX_TEXT).min(1), by: z.string().max(40) }),
  z.object({ t: z.literal('itemDismissed'), itemId: z.string().min(1).max(100) }),
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('frame'), b: browserId, d: frameData }),
  z.object({ t: z.literal('browserDecision'), id: browserId, allow: z.boolean() }),
  /** The Mac's nonce for a browser request (spec §1 step 4); the browser has already committed to its key. */
  z.object({ t: z.literal('browserNonce'), id: browserId, macPublicKey: z.string().regex(PUBKEY_RE), nonce: z.string().regex(NONCE_RE) }),
  z.object({ t: z.literal('browserClose'), b: browserId }),
])
export type DesktopMsg = z.infer<typeof DesktopMsg>

export type ServerToDesktop =
  | { t: 'welcome'; pending: Command[]; user?: { id: string; email: string } }
  | { t: 'command'; cmd: Command }
  | { t: 'items'; items: ExternalItem[] }
  | { t: 'pong' }
  | { t: 'snapshotAck'; v: number }
  | { t: 'snapshotNeeded'; reason: string }
  | { t: 'error'; code: string; message: string }
  | { t: 'frame'; b: string; d: string }
  | { t: 'open'; b: string; name: string; publicKey: string }
  | { t: 'close'; b: string }
  | { t: 'browserRequest'; id: string; name: string; email: string; commit: string; expiresAt: number }
  | { t: 'browserReveal'; id: string; publicKey: string; nonce: string }
  | { t: 'browserRevoked'; id: string }

export const ClientMsg = z.discriminatedUnion('t', [z.object({ t: z.literal('resync') })])
export type ClientMsg = z.infer<typeof ClientMsg>

export interface DesktopStatus {
  online: boolean
  lastSeen: number | null
  appVersion: string | null
}

export interface JsonPatchOp {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
  path: string
  value?: unknown
  from?: string
}

export type ServerToClient =
  | { t: 'snapshot'; v: number; data: RemoteSnapshot | null; desktop: DesktopStatus }
  | { t: 'patch'; from: number; to: number; ops: JsonPatchOp[] }
  | { t: 'desktop'; desktop: DesktopStatus }
  | { t: 'command'; record: CommandRecord }
  | { t: 'item'; item: ExternalItem }
  | { t: 'error'; code: string; message: string }

export const BrowserMsg = z.discriminatedUnion('t', [z.object({ t: z.literal('frame'), d: frameData }), z.object({ t: z.literal('ping') })])
export type BrowserMsg = z.infer<typeof BrowserMsg>

/**
 * Browser socket close codes (the web app acts on them):
 * 4003 revoked or signed out (keys deleted, approval again) · 4006 session re-check, reconnect at once ·
 * 4008 closed by the Mac (re-check the session and the browser's status, then back off) ·
 * 4009 open in another tab of this browser (terminal; "Use here" reconnects and bumps the other tab).
 */
export type ServerToBrowser =
  | { t: 'frame'; d: string }
  | { t: 'desktop'; desktop: DesktopStatus }
  | { t: 'pong' }
  | { t: 'error'; code: string; message: string }
