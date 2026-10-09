import { appendFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { TICKET_BUILDER_NAME, TICKET_TAB } from '@shared/ticketBuilder'
import { enforceSettings, overrideNote, readSettings } from '@shared/ticketSettings'
import { bodyFileAllowed, parseCreateArgs, sweepTicketDirs } from './boardOps'

/**
 * The Board's ticket builder (Create with Claude) folders: `<home>/ticket-builder/` with one
 * account; with two or more, one per Board tab, `<home>/ticket-builder/tab-<tabId>/`, whose session
 * runs as the tab's account. Each folder has its own CLAUDE.md, context.json (its account),
 * create-ticket.sh, requests/, answers/ and created.jsonl.
 */
export function ticketBuilderDir(home: string, tab: string | null, multi: boolean): string {
  const root = join(home, 'ticket-builder')
  if (!multi) return root
  if (!tab || !TICKET_TAB.test(tab)) throw new Error(`refusing a ticket builder for tab ${JSON.stringify(tab)}`)
  return join(root, `tab-${tab}`)
}

/** The folders whose requests MasterDeck answers: the shared one (one account), else every tab folder. */
export function ticketDirs(home: string, multi: boolean): string[] {
  const root = join(home, 'ticket-builder')
  if (!multi) return [root]
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .filter((n) => n.startsWith('tab-') && TICKET_TAB.test(n.slice(4)))
    .map((n) => join(root, n))
    .filter((d) => {
      try {
        return lstatSync(d).isDirectory() && ticketDirOk(home, d)
      } catch {
        return false
      }
    })
}

/**
 * A ticket folder MasterDeck may write and answer in: the shared folder, or a real (not symlinked)
 * folder whose real path is directly inside the real `<home>/ticket-builder`. One not made yet is fine.
 */
export function ticketDirOk(home: string, dir: string): boolean {
  const root = join(home, 'ticket-builder')
  if (dir === root) return true
  try {
    if (!lstatSync(dir).isDirectory()) return false
  } catch {
    return true
  }
  try {
    return dirname(realpathSync(dir)) === realpathSync(root)
  } catch {
    return false
  }
}

/** The account a tab folder's context.json names (written by Create with Claude); null if none or a bad tab. */
export function folderAccount(home: string, tab: string): string | null {
  try {
    const a = JSON.parse(readFileSync(join(ticketBuilderDir(home, tab, true), 'context.json'), 'utf8')).account
    return typeof a === 'string' ? a : null
  } catch {
    return null
  }
}

type SettingsArgs = (login?: string) => { ok: true; args: string[] } | { ok: false; message: string }

/**
 * Where a ticket-builder pane runs and as whom. One account: the shared folder, no settings (as
 * before; tab and account ignored). Several: the tab's folder as the tab's account; a bad tab, no
 * account, or an account that can't start is refused, never run as gh's active account.
 */
export function ticketPane(
  home: string,
  multi: boolean,
  spec: { tab?: string; account?: string },
  settingsArgs: SettingsArgs,
): { cwd: string; tab?: string; settings: string[] } | { error: string } {
  if (!multi) return { cwd: ticketBuilderDir(home, null, false), settings: [] }
  let cwd: string
  try {
    cwd = ticketBuilderDir(home, spec.tab ?? null, true)
  } catch (e) {
    return { error: (e as Error).message }
  }
  if (!ticketDirOk(home, cwd)) return { error: 'refusing a ticket builder folder that is a link' }
  if (!spec.account) return { error: 'refusing a ticket builder without its tab account' }
  const s = settingsArgs(spec.account)
  if (!s.ok) return { error: s.message }
  // No --settings while multi: the accounts' files are not written yet (as sessionSettings refuses).
  return s.args.length ? { cwd, tab: spec.tab, settings: s.args } : { error: 'GitHub accounts are still loading; try again in a few seconds' }
}

type CreateFn = (p: Exclude<ReturnType<typeof parseCreateArgs>, { error: string }>, picked: string | null) => Promise<object>

/**
 * One folder's Create-with-Claude requests: claim each, create it with the account this folder's
 * context.json names (`create` picks via ticketAccount) and the values of its settings bar (they
 * replace the session's flags; the answer names each one replaced), answer, and log it to created.jsonl.
 */
export async function pumpTicketDir(dir: string, create: CreateFn): Promise<void> {
  sweepTicketDirs(dir) // stale requests are dropped, not created for nobody
  const req = join(dir, 'requests')
  let names: string[] = []
  try {
    names = readdirSync(req).filter((n) => n.endsWith('.req'))
  } catch {
    return
  }
  for (const n of names) {
    const id = n.slice(0, -4)
    if (!/^[0-9]+-[0-9]+-[0-9]+$/.test(id)) continue
    try {
      renameSync(join(req, n), join(req, `${id}.taken`))
    } catch {
      continue // taken back by the script (timed out)
    }
    let answer: object
    try {
      const args = readFileSync(join(req, `${id}.taken`), 'utf8').split('\0').slice(0, -1).slice(0, 60)
      const p = parseCreateArgs(args)
      if ('error' in p) answer = { ok: false, error: p.error }
      else {
        const file = p.bodyFile ? bodyFileAllowed(dir, p.bodyFile) : ''
        if (file === null) answer = { ok: false, error: 'create: body file outside the ticket folder' }
        else {
          const body = file ? readFileSync(file, 'utf8').slice(0, 60_000) : ''
          // This folder's context.json says which account the dialog / tab picked, and what the
          // settings bar holds (read now, so a change in the bar applies to the next ticket).
          let ctx: { account?: unknown; settings?: unknown } = {}
          try {
            ctx = JSON.parse(readFileSync(join(dir, 'context.json'), 'utf8')) ?? {}
          } catch {
            /* none */
          }
          const picked = typeof ctx.account === 'string' ? ctx.account : null
          const bar = readSettings(ctx.settings)
          const { req, overridden } = bar ? enforceSettings({ ...p, body }, bar) : { req: { ...p, body }, overridden: [] }
          // A bar that is there but unreadable is refused, never silently dropped: the user expects it to apply.
          const made = ctx.settings !== undefined && !bar
            ? { ok: false, error: 'create: the settings bar could not be read; change a value in it and try again' }
            : await create(req, picked)
          answer = {
            ...made,
            ...(bar ? { applied: { repo: req.repo, project: req.project ?? '', status: req.status ?? '', assignees: req.assignees, labels: req.labels, milestone: req.milestone ?? '', sprint: req.sprint ?? '' } } : {}),
            ...(overridden.length ? { overridden, note: `Set by the settings bar, not your flags: ${overrideNote(overridden)}. Tell the user.` } : {}),
          }
        }
      }
    } catch (e) {
      answer = { ok: false, error: `create: ${String(e)}` }
    }
    const a = join(dir, 'answers')
    mkdirSync(a, { recursive: true })
    writeFileSync(join(a, `${id}.tmp`), JSON.stringify(answer))
    renameSync(join(a, `${id}.tmp`), join(a, `${id}.json`))
    // The log the Board reads (readCreatedTickets) — dry runs are not logged.
    if ((answer as { ok?: boolean; dryRun?: boolean }).ok && !(answer as { dryRun?: boolean }).dryRun)
      appendFileSync(join(dir, 'created.jsonl'), JSON.stringify(answer) + '\n')
  }
}

/** MasterDeck's own ticket builder (shared or a tab's), not the user's work: hidden from the session list. */
export function isTicketBuilderSession(s: { name?: string; cwd?: string }, home: string): boolean {
  if (s.name === TICKET_BUILDER_NAME || s.name?.startsWith(`${TICKET_BUILDER_NAME}-`)) return true
  const root = resolve(join(home, 'ticket-builder'))
  const cwd = resolve(s.cwd || '/')
  return cwd === root || (dirname(cwd) === root && basename(cwd).startsWith('tab-'))
}
