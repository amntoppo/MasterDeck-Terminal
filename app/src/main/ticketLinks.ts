import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { emptyLinks, importLinks, parseLinkFile, withLink, withPr, type LinkFile } from '@shared/ticketLinks'
import type { Ticket } from '@shared/ticket'
import type { Runner } from './run'

/**
 * MasterDeck's session ↔ ticket links (`<home>/ticket-links.json`). Read every agents poll (no
 * cache: two instances are fine); only MasterDeck writes it. tt.sh's `state.json` is imported once
 * (importOnce) and then never read or written again: links made later by hand with the
 * babysit-ticket skill stay in tt.sh's file only.
 */
export class LinkStore {
  constructor(
    private file: string,
    private legacy: string,
  ) {}

  private load(path: string): LinkFile {
    try {
      return parseLinkFile(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return emptyLinks()
    }
  }

  private save(f: LinkFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(f, null, 2) + '\n')
    renameSync(`${this.file}.tmp`, this.file)
  }

  read(): LinkFile {
    return this.load(this.file)
  }

  /** Copy tt.sh's links in, the first time only. True when it ran. */
  importOnce(now = Date.now()): boolean {
    const own = this.load(this.file)
    if (own.importedAt !== undefined) return false
    this.save({ ...importLinks(own, this.load(this.legacy)), importedAt: now })
    return true
  }

  link(sessionId: string, t: Ticket, title: string, branch: string): void {
    this.save(withLink(this.load(this.file), sessionId, t, title, branch, new Date()))
  }

  addPr(sessionId: string, url: string): void {
    this.save(withPr(this.load(this.file), sessionId, url))
  }
}

/** Long-lived branches every session shares never carry a link (tt.sh's rule). */
const SHARED = new Set(['main', 'master', 'dev', 'dev2', 'develop', 'stage', 'staging', 'prod', 'production'])

/** `Owner/repo@branch` for the checkout's feature branch, else "" (port of tt.sh branch_key). */
export async function branchKey(run: Runner, dir: string): Promise<string> {
  if (!dir || !existsSync(dir)) return ''
  const git = (...a: string[]) => run('git', ['-C', dir, ...a], { timeoutMs: 10_000 })
  const br = (await git('symbolic-ref', '--quiet', '--short', 'HEAD')).stdout.trim()
  if (!br || SHARED.has(br)) return ''
  const def = (await git('symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')).stdout.trim()
  if (def && br === def.replace(/^origin\//, '')) return ''
  const url = (await git('remote', 'get-url', 'origin')).stdout.trim()
  if (!url) return ''
  const slug = url.replace(/\.git$/, '').replace(/^[a-z+]+:\/\/[^/]+\//, '').replace(/^[^@/]+@[^:]+:/, '')
  return `${slug}@${br}`
}
