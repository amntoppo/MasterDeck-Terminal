import { readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { getConfig, projectKey, statusesFor, statusRank, type AppConfig, type ProjectConfig } from '@shared/appConfig'
import { fullRepo, ticketLabel, type Ticket } from '@shared/ticket'
import type { CliResult } from '@shared/types'
import type { GhRunner } from './ghc'

/**
 * Board writes MasterDeck makes itself (formerly babysit-ticket's tt.sh): read an issue's item and
 * status on the first configured board that has it, move it forward only (or forced, for the
 * Board's own status menu), link a PR under the issue's Development box, create an issue on a
 * board with status and sprint. Reads right before a write skip the cache; writes pass through ghc.
 */

export interface IssueInfo {
  title: string
  state: string
  item: string | null
  project: string | null
  status: string
}

export interface CreateOpts {
  repo?: string
  title: string
  body: string
  project?: string
  status?: string
  assignees?: string[]
  labels?: string[]
  milestone?: string
  sprint?: string
  sprintField?: string
  dryRun?: boolean
}

export type CreateResult =
  | { ok: true; dryRun?: boolean; url?: string; number?: number; project: string; status: string; sprint: string }
  | { ok: false; error: string; url?: string; number?: number }

const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([\w.-]+)\/pull\/(\d+)/

type J = Record<string, unknown>
const o = (v: unknown): J => (v && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const json = (t: string): unknown => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

const ISSUE_INFO = (owner: string, name: string) =>
  `query($n:Int!){repository(owner:"${owner}",name:"${name}"){issue(number:$n){title state projectItems(first:20){nodes{id project{number owner{... on Organization{login} ... on User{login}}} fieldValues(first:30){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2SingleSelectField{id}}}}}}}}}}`

export class BoardOps {
  constructor(
    private gh: GhRunner,
    private config: () => AppConfig = getConfig,
  ) {}

  private board(key: string | null): ProjectConfig | null {
    return this.config().projects.find((p) => projectKey(p) === key) ?? null
  }

  async issueInfo(t: Ticket): Promise<IssueInfo | null> {
    const repo = fullRepo(t.repo)
    if (!REPO.test(repo)) return null
    const [owner, name] = repo.split('/')
    const r = await this.gh(['api', 'graphql', '-F', `n=${t.number}`, '-f', `query=${ISSUE_INFO(owner, name)}`], { timeoutMs: 30_000, force: true })
    if (r.code !== 0) return null
    const i = o(o(o(o(json(r.stdout)).data).repository).issue)
    if (!s(i.title)) return null
    const items = arr(o(i.projectItems).nodes).map(o)
    const keyOf = (n: J) => `${s(o(o(n.project).owner).login)}/${o(n.project).number}`
    // Config order: the first selected board that holds the issue.
    for (const p of this.config().projects) {
      const it = items.find((n) => keyOf(n) === projectKey(p))
      if (!it) continue
      const status = arr(o(it.fieldValues).nodes).map(o).find((v) => s(o(v.field).id) === p.statusFieldId)
      return { title: s(i.title), state: s(i.state), item: s(it.id) || null, project: projectKey(p), status: s(status?.name) }
    }
    return { title: s(i.title), state: s(i.state), item: null, project: null, status: '' }
  }

  async move(t: Ticket, target: string, opts: { force?: boolean } = {}): Promise<CliResult> {
    const lab = ticketLabel(t.repo, t.number)
    const info = await this.issueInfo(t)
    if (!info) return { ok: false, message: `could not read ${lab}` }
    if (!info.item) return { ok: false, message: `${lab} is not on any selected board` }
    const p = this.board(info.project)!
    const opt = p.statusOptions[target]
    if (!opt) return { ok: false, message: `unknown status '${target}' on board ${info.project}` }
    if (info.status === target) return { ok: true, message: `${lab} already ${target}` }
    if (!opts.force && statusRank(info.status, this.config(), info.project) >= statusRank(target, this.config(), info.project))
      return { ok: true, message: `${lab} left at ${info.status} (not moving back to ${target})` }
    const r = await this.gh(['project', 'item-edit', '--project-id', p.id, '--id', info.item, '--field-id', p.statusFieldId, '--single-select-option-id', opt], { timeoutMs: 30_000 })
    if (r.code !== 0) return { ok: false, message: `board update failed for ${lab}: ${(r.stderr || r.stdout).trim().slice(0, 200)}` }
    return { ok: true, message: `${lab}: ${info.status || 'no status'} -> ${target}` }
  }

  setStatus(t: Ticket, status: string): Promise<CliResult> {
    return this.move(t, status, { force: true })
  }

  /** Add the PR to the issue's Development box (a closing reference: GitHub has no other kind). */
  async linkPr(t: Ticket, url: string): Promise<boolean> {
    const m = PR_URL.exec(url)
    const repo = fullRepo(t.repo)
    if (!m || !REPO.test(repo)) return false
    const [owner, name] = repo.split('/')
    // Node ids never change: cache them for an hour.
    const iid = await this.gh(['api', 'graphql', '-F', `n=${t.number}`, '-f', `query=query($n:Int!){repository(owner:"${owner}",name:"${name}"){issue(number:$n){id}}}`, '--jq', '.data.repository.issue.id'], { ttl: 3600, timeoutMs: 30_000 })
    const pid = await this.gh(['api', 'graphql', '-F', `p=${m[3]}`, '-f', `query=query($p:Int!){repository(owner:"${m[1]}",name:"${m[2]}"){pullRequest(number:$p){id}}}`, '--jq', '.data.repository.pullRequest.id'], { ttl: 3600, timeoutMs: 30_000 })
    const i = iid.code === 0 ? iid.stdout.trim() : ''
    const p = pid.code === 0 ? pid.stdout.trim() : ''
    if (!i || !p) return false
    const r = await this.gh(['api', 'graphql', '-f', 'query=mutation($i:ID!,$p:[ID!]!){addCloseIssueReferences(input:{issueId:$i,pullRequestIds:$p}){clientMutationId}}', '-f', `i=${i}`, '-f', `p=${p}`], { timeoutMs: 30_000 })
    return r.code === 0
  }

  async create(c: CreateOpts): Promise<CreateResult> {
    const cfg = this.config()
    const repo = c.repo || fullRepo(null)
    if (!REPO.test(repo)) return { ok: false, error: `create: bad --repo '${repo}' (owner/name)` }
    if (!c.title.trim()) return { ok: false, error: 'create: --title is required' }
    const project = c.project || (cfg.projects[0] ? projectKey(cfg.projects[0]) : '')
    const p = project ? this.board(project) : null
    if (project && !p) return { ok: false, error: `create: ${project} is not a configured board` }
    const opt = c.status ? p?.statusOptions[c.status] : undefined
    if (c.status && !p) return { ok: false, error: 'create: no board to set the status on' }
    if (c.status && !opt) return { ok: false, error: `create: unknown status '${c.status}' on board ${project}` }
    if (c.dryRun) return { ok: true, dryRun: true, project, status: c.status ?? '', sprint: c.sprint ?? '' }
    const args = ['issue', 'create', '-R', repo, '--title', c.title, '--body', c.body]
    for (const a of c.assignees ?? []) if (a) args.push('--assignee', a)
    for (const l of c.labels ?? []) args.push('--label', l)
    if (c.milestone) args.push('--milestone', c.milestone)
    const made = await this.gh(args, { timeoutMs: 60_000 })
    const url = /https:\/\/github\.com\/[^ \n]+\/issues\/\d+/.exec(made.stdout)?.[0]
    if (made.code !== 0 || !url) return { ok: false, error: `create: gh issue create failed: ${(made.stderr || made.stdout).trim().split('\n').pop() ?? ''}` }
    const number = Number(url.split('/').pop())
    if (!p) return { ok: true, url, number, project: '', status: '', sprint: '' }
    const added = await this.gh(['project', 'item-add', String(p.number), '--owner', p.owner, '--url', url, '--format', 'json'], { timeoutMs: 60_000 })
    const item = s(o(json(added.stdout)).id)
    if (added.code !== 0 || !item) return { ok: false, url, number, error: 'the issue was created but could not be added to the board' }
    const edit = (field: string, flag: string, value: string) =>
      this.gh(['project', 'item-edit', '--project-id', p.id, '--id', item, '--field-id', field, flag, value], { timeoutMs: 30_000 })
    let status = ''
    if (opt && (await edit(p.statusFieldId, '--single-select-option-id', opt)).code === 0) status = c.status!
    let sprint = ''
    if (c.sprint) {
      const field = (c.sprintField || p.sprintField || cfg.sprintField || 'Sprint').replace(/"/g, '')
      const q = await this.gh(['api', 'graphql', '-f', `query=query{node(id:"${p.id}"){... on ProjectV2{field(name:"${field}"){... on ProjectV2IterationField{id configuration{iterations{id title startDate duration}}}}}}}`], { timeoutMs: 30_000, ttl: 300 })
      const f = o(o(o(json(q.stdout)).data).node).field
      const its = arr(o(o(f).configuration).iterations).map(o)
      const now = Date.now()
      const it =
        c.sprint === '@current'
          ? its.find((x) => Date.parse(s(x.startDate)) <= now && Date.parse(s(x.startDate)) + Number(x.duration) * 86_400_000 > now)
          : its.find((x) => s(x.title) === c.sprint)
      if (s(o(f).id) && it && (await edit(s(o(f).id), '--iteration-id', s(it.id))).code === 0) sprint = c.sprint
    }
    return { ok: true, url, number, project, status, sprint }
  }
}

/** tt.sh `create` flags (the ticket builder's create-ticket.sh passes them through). */
export function parseCreateArgs(argv: string[]): (Omit<CreateOpts, 'body'> & { body: string; bodyFile?: string }) | { error: string } {
  const out: Omit<CreateOpts, 'body'> & { body: string; bodyFile?: string } = { title: '', body: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = () => argv[++i] ?? ''
    if (a === '--title') out.title = v()
    else if (a === '--repo') out.repo = v()
    else if (a === '--body-file') out.bodyFile = v()
    else if (a === '--status') out.status = v()
    else if (a === '--project') out.project = v()
    else if (a === '--assignee') out.assignees = v().split(',').map((x) => x.trim()).filter(Boolean)
    else if (a === '--label') out.labels = [...(out.labels ?? []), v()]
    else if (a === '--milestone') out.milestone = v()
    else if (a === '--sprint') out.sprint = v()
    else if (a === '--sprint-field') out.sprintField = v()
    else if (a === '--dry-run') out.dryRun = true
    else return { error: `create: unknown option ${a}` }
  }
  return out
}

export interface LinkDeps {
  ops: Pick<BoardOps, 'issueInfo' | 'move'>
  /** Writes the link; may throw (a broken links file that cannot be moved aside). */
  link: (sessionId: string, t: Ticket, title: string, branch: string) => void
  branch: (cwd: string) => Promise<string>
  /** Whether the session's workflow keeps the `ticket` built-in. */
  moves: (sessionId: string) => boolean
  /** Reached the `linked` stage (what a transcript's "linked session to #" used to show). */
  mark: (sessionId: string, trigger: 'linked') => void
  reload: () => void
  noteStatus: (t: Ticket, status: string) => void
}

/**
 * Link a session to an issue: MasterDeck's ticket links, keyed by the session and its feature
 * branch; then, when the session's workflow keeps the `ticket` built-in, the ticket moves to the
 * board's in-progress status (forward only).
 */
export async function linkTicket(d: LinkDeps, t: Ticket, sessionId: string, cwd: string | null): Promise<CliResult> {
  const label = ticketLabel(t.repo, t.number)
  const info = await d.ops.issueInfo(t)
  if (!info) return { ok: false, message: `could not read ${label}` }
  if (!info.item) return { ok: false, message: `${label} is not on any selected board` }
  try {
    d.link(sessionId, t, info.title, cwd ? await d.branch(cwd) : '')
  } catch (e) {
    console.error('ticket links: could not write the link', e)
    return { ok: false, message: `could not save the link for ${label}: ${(e as Error).message}` }
  }
  d.reload()
  d.mark(sessionId, 'linked')
  let moved = ''
  if (d.moves(sessionId)) {
    const target = statusesFor(info.project).inProgress
    const m = await d.ops.move(t, target)
    moved = `; ${m.message}`
    if (m.ok && !/left at|already/.test(m.message)) d.noteStatus(t, target)
  }
  return { ok: true, message: `linked session to ${label} ${info.title}${moved}` }
}

/**
 * The ticket builder session's create command: it hands its tt.sh-style flags to MasterDeck (which
 * runs BoardOps.create) and prints the answer, waiting up to 90 s (under Claude Code's 120 s Bash
 * timeout). MasterDeck runs while this session does (the session lives in its window).
 */
export function ticketBuilderScript(dir: string): string {
  const d = dir.replace(/'/g, `'\\''`)
  return `#!/usr/bin/env bash
# Written by MasterDeck: create one ticket on the board (MasterDeck does it) and print the result.
d='${d}'
if [ $# -eq 0 ]; then
  echo '{"ok":false,"error":"usage: ./create-ticket.sh --title T [--repo R] [--body-file F] [--status S] [--project P] [--assignee A] [--label L] [--milestone M] [--dry-run]"}'
  exit 1
fi
fail() { echo '{"ok":false,"error":"could not hand the request to MasterDeck"}'; exit 1; }
mkdir -p "$d/requests" "$d/answers" || fail
id="$(date +%s)-$$-$RANDOM"
# One NUL-terminated argument each: any text survives, no jq needed.
{ printf '%s\\0' "$@" > "$d/requests/$id.tmp" && mv "$d/requests/$id.tmp" "$d/requests/$id.req"; } || fail
i=0
while [ $i -lt 360 ]; do
  if [ -f "$d/answers/$id.json" ]; then
    out="$(cat "$d/answers/$id.json")"; echo "$out"; rm -f "$d/answers/$id.json" "$d/requests/$id.taken"
    case "$out" in *'"ok":false'*) exit 1 ;; esac
    exit 0
  fi
  sleep 0.25
  i=$((i + 1))
done
if [ -f "$d/requests/$id.taken" ]; then
  echo '{"ok":false,"pending":true,"message":"MasterDeck is still creating it — check the board before retrying"}'
  exit 1
fi
rm -f "$d/requests/$id.req"
echo '{"ok":false,"error":"MasterDeck did not answer (is it running?)"}'
exit 1
`
}

/**
 * The --body-file a ticket session named: the real path if it is a regular file really inside `dir`
 * (symlinks resolved on both sides), else null.
 */
export function bodyFileAllowed(dir: string, file: string): string | null {
  try {
    const root = realpathSync(dir)
    const real = realpathSync(resolve(dir, file))
    return real.startsWith(root + sep) && statSync(real).isFile() ? real : null
  } catch {
    return null
  }
}

/** Housekeeping for the ticket-builder folder: stale requests, old claims and answers, leftover temp files. */
export function sweepTicketDirs(dir: string, now = Date.now()): void {
  const sweep = (sub: string, test: (n: string, age: number) => boolean) => {
    let names: string[] = []
    try { names = readdirSync(join(dir, sub)) } catch { return }
    for (const n of names) {
      try {
        const f = join(dir, sub, n)
        if (test(n, now - statSync(f).mtimeMs)) unlinkSync(f)
      } catch { /* gone already */ }
    }
  }
  sweep('requests', (n, age) => n.endsWith('.tmp') || (n.endsWith('.req') && age > 2 * 60_000) || (n.endsWith('.taken') && age > 10 * 60_000))
  sweep('answers', (n, age) => n.endsWith('.tmp') || age > 10 * 60_000)
}
