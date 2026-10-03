import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AssignRequest, QueueEdit } from '@shared/ipc'
import { MASTER_NAME } from '@shared/derive'
import { CommandInput, type Command, type CommandResult } from '@shared/remote'
import type { Ticket } from '@shared/ticket'
import type { AppState, CliResult, DraftAssign, Session } from '@shared/types'

export interface RemoteDeps {
  state(): AppState | null
  /** The inbox's act + sources.changed(), as the inboxAct IPC handler does. */
  inboxAct(itemId: string, type: string, payload: Record<string, unknown>): Promise<CliResult>
  draftAssign(t: Ticket): Promise<{ ok: true; draft: DraftAssign } | { ok: false; message: string }>
  startAssign(req: AssignRequest): Promise<CliResult>
  /** `claude stop <bgId>` without the confirm dialog, then refresh the session list. */
  stopBg(bgId: string): Promise<CliResult>
  resume(sessionId: string, name: string, cwd: string | null): Promise<CliResult>
  sendNow(s: Session, text: string): Promise<CliResult>
  queueEdit(sessionId: string, edit: QueueEdit): CliResult
  setManualStatus(key: string, status: unknown): CliResult
  /** isMulti(getConfig()): two or more accounts in the config (ahead of state.ghAccounts at startup). */
  isMulti(): boolean
  /** The logins in the config. */
  configLogins(): string[]
}

/** `transient`: not a final answer (MasterDeck is still loading); the caller runs it again later. */
export type RemoteOutcome = CommandResult & { status?: 'stale'; transient?: true }

const KEEP = 500
const LOADING = 'MasterDeck is still loading; try again'
const MASTER_MSG = 'master-agent cannot be controlled remotely'
const STALE: RemoteOutcome = { ok: false, status: 'stale', message: 'that is no longer waiting on you' }

/**
 * Commands from the remote backend, run through the same functions as the window's buttons. Each
 * command id runs once: its outcome is kept (the last 500, in `remote-done.json`) and returned again
 * if the backend re-sends it after a reconnect.
 */
export class RemoteCommands {
  private done = new Map<string, RemoteOutcome>()
  private running = new Map<string, Promise<RemoteOutcome>>()

  constructor(
    private deps: RemoteDeps,
    private file: string,
  ) {
    try {
      const rows = JSON.parse(readFileSync(file, 'utf8')) as [string, RemoteOutcome][]
      if (Array.isArray(rows)) for (const [id, r] of rows) if (typeof id === 'string' && r && typeof r === 'object') this.done.set(id, r)
    } catch {
      // first run
    }
  }

  /**
   * Outcomes are recorded after the handler finishes, so a crash mid-run means at-least-once on
   * redelivery (the command may run again).
   */
  run(cmd: Command): Promise<RemoteOutcome> {
    const prev = this.done.get(cmd.id) ?? this.readBack(cmd.id)
    if (prev) return Promise.resolve(prev)
    const inflight = this.running.get(cmd.id)
    if (inflight) return inflight
    const p = this.checked(cmd)
      .catch((e): RemoteOutcome => ({ ok: false, message: `failed: ${String(e)}` }))
      .then((r) => {
        if (!r.transient) this.remember(cmd.id, r)
        this.running.delete(cmd.id)
        return r
      })
    this.running.set(cmd.id, p)
    return p
  }

  /**
   * The backend validates too, but a client token is less trusted than the desktop: check the
   * command against the same wire contract here and run the parsed (defaulted) form.
   */
  private async checked(cmd: Command): Promise<RemoteOutcome> {
    const { id, createdAt, by, ...input } = cmd
    const parsed = CommandInput.safeParse(input)
    if (!parsed.success) return { ok: false, message: 'bad command' }
    return this.exec({ ...parsed.data, id, createdAt, by })
  }

  /** Another instance (an earlier launch) may have run it since this one loaded. */
  private readBack(id: string): RemoteOutcome | undefined {
    try {
      const rows = JSON.parse(readFileSync(this.file, 'utf8')) as [string, RemoteOutcome][]
      return rows.find(([x]) => x === id)?.[1]
    } catch {
      return undefined
    }
  }

  private remember(id: string, r: RemoteOutcome): void {
    this.done.set(id, r)
    while (this.done.size > KEEP) this.done.delete(this.done.keys().next().value!)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify([...this.done]))
      renameSync(`${this.file}.tmp`, this.file)
    } catch (e) {
      console.error('remote-done write failed', e)
      // kept in memory; the file is written again next time
    }
  }

  private async exec(cmd: Command): Promise<RemoteOutcome> {
    const st = this.deps.state()
    if (!st) return { ok: false, transient: true, message: LOADING }
    const by = `remote:${cmd.by}`.slice(0, 40)
    const session = (key: string) => st.sessions.find((s) => s.key === key)
    switch (cmd.type) {
      case 'inbox.act':
      case 'inbox.snooze':
      case 'inbox.dismiss': {
        const live = [...st.inbox.open, ...st.inbox.snoozed].some((e) => e.item.id === cmd.itemId)
        if (!live) return STALE
        if (cmd.type === 'inbox.snooze') return this.deps.inboxAct(cmd.itemId, 'snooze', { minutes: cmd.args.minutes, by })
        if (cmd.type === 'inbox.dismiss') return this.deps.inboxAct(cmd.itemId, 'dismiss', { by })
        const { action, ...rest } = cmd.args
        return this.deps.inboxAct(cmd.itemId, action, { ...rest, by })
      }
      case 'session.start': {
        // One account: the field is dropped and the session starts as today (F7). Two or more: it must be a configured
        // login that is healthy now; ghAccounts lags the config, so an unlisted one fails closed (never dropped).
        let account: string | undefined
        if (cmd.args.account && this.deps.isMulti()) {
          const want = cmd.args.account.toLowerCase()
          const login = this.deps.configLogins().find((l) => l.toLowerCase() === want)
          if (!login) return { ok: false, message: `${cmd.args.account} is not a GitHub account connected on this Mac` }
          const st2 = (st.ghAccounts ?? []).find((a) => a.login.toLowerCase() === want)
          if (!st2) return { ok: false, message: 'GitHub accounts are still loading on this Mac; try again in a few seconds' }
          if (!st2.healthy) return { ok: false, message: `${login} is not a GitHub account connected on this Mac` }
          account = login
        }
        const d = await this.deps.draftAssign({ repo: cmd.args.repo ?? null, number: cmd.args.issue })
        if (!d.ok) return { ok: false, message: d.message }
        const prompt = cmd.args.prompt?.trim()
        const req: AssignRequest = {
          issue: d.draft.issue,
          repo: d.draft.repo ?? null,
          name: d.draft.name,
          cwd: d.draft.cwd,
          prompt: prompt || d.draft.prompt,
          proposalId: d.draft.proposalId,
          edited: !!prompt,
          approved: false,
          ...(cmd.args.model ? { model: cmd.args.model } : {}),
          ...(account ? { account } : {}),
        }
        return this.deps.startAssign(req)
      }
      case 'session.stop': {
        const s = session(cmd.args.key)
        if (!s) return { ok: false, message: 'session not found' }
        if (s.name === MASTER_NAME) return { ok: false, message: MASTER_MSG }
        if (!s.bgId) return { ok: false, message: `${s.name} runs in another terminal; only background sessions can be stopped remotely` }
        return this.deps.stopBg(s.bgId)
      }
      case 'session.resume': {
        const s = session(cmd.args.key)
        if (!s) return { ok: false, message: 'session not found' }
        if (s.name === MASTER_NAME) return { ok: false, message: MASTER_MSG }
        if (s.state !== 'done' && s.state !== 'suspended') return { ok: false, message: `${s.name} is ${s.state}, not stopped` }
        return this.deps.resume(s.sessionId, s.name, s.cwd)
      }
      case 'session.send': {
        const s = session(cmd.args.key)
        if (!s || s.state === 'done') return { ok: false, message: 'session not found' }
        if (s.name === MASTER_NAME) return { ok: false, message: MASTER_MSG }
        if (s.state === 'needs-input') return { ok: false, message: `${s.name} is waiting on a prompt; answer it from Needs you instead` }
        if (s.state === 'suspended') return { ok: false, message: `${s.name} is suspended; resume it first` }
        if (cmd.args.via === 'now' || s.state === 'idle') return this.deps.sendNow(s, cmd.args.text)
        if (!st.hooks.queue)
          return { ok: false, message: "nothing runs /queue on this machine (no complete queue hook is installed), so a queued message would never be sent; send it now instead" }
        return this.deps.queueEdit(s.sessionId, { op: 'add', text: cmd.args.text })
      }
      case 'queue.edit': {
        const s = session(cmd.args.key)
        if (!s) return { ok: false, message: 'session not found' }
        if (s.name === MASTER_NAME) return { ok: false, message: MASTER_MSG }
        const { ok, message } = this.deps.queueEdit(s.sessionId, cmd.args.edit as QueueEdit)
        return { ok, message }
      }
      case 'session.setStatus': {
        const s = session(cmd.args.key)
        if (!s || s.state === 'done') return { ok: false, message: 'session not found' }
        if (s.name === MASTER_NAME) return { ok: false, message: MASTER_MSG }
        return this.deps.setManualStatus(cmd.args.key, cmd.args.status)
      }
      default:
        return { ok: false, message: `unsupported: ${(cmd as { type: string }).type}` }
    }
  }
}
