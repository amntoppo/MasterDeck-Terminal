import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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

  private lastGood: LinkFile = emptyLinks()

  /** null: the file exists but is unreadable or broken. A missing file is just empty. */
  private load(path: string): LinkFile | null {
    try {
      return parseLinkFile(JSON.parse(readFileSync(path, 'utf8')))
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? emptyLinks() : null
    }
  }

  /** Our own file for a write: a broken one is moved aside (never overwritten), then we start empty. */
  private forWrite(): { f: LinkFile; wasBroken: boolean } {
    const f = this.load(this.file)
    if (f) return { f, wasBroken: false }
    const aside = this.file.replace(/\.json$/, '') + `.corrupt.${Date.now()}.json`
    renameSync(this.file, aside)
    console.error(`ticket links: ${this.file} is unreadable, moved to ${aside}`)
    return { f: emptyLinks(), wasBroken: true }
  }

  private save(f: LinkFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(f, null, 2) + '\n')
      renameSync(tmp, this.file)
    } catch (e) {
      try {
        unlinkSync(tmp)
      } catch {
        // nothing to clean
      }
      throw e
    }
    this.lastGood = f
  }

  /** The links for display; an unreadable file keeps the last good ones. */
  read(): LinkFile {
    const f = this.load(this.file)
    if (f) this.lastGood = f
    return this.lastGood
  }

  /** Copy tt.sh's links in, the first time only. True when it ran. */
  importOnce(now = Date.now()): boolean {
    const { f: own, wasBroken } = this.forWrite()
    if (wasBroken) {
      // Its data is in the backup; never fall back to tt.sh's file.
      this.save({ ...own, importedAt: now })
      return false
    }
    if (own.importedAt !== undefined) return false
    const legacy = this.load(this.legacy)
    if (!legacy) return false // mid-write or unreadable: try again next launch
    this.save({ ...importLinks(own, legacy), importedAt: now })
    return true
  }

  link(sessionId: string, t: Ticket, title: string, branch: string): void {
    this.save(withLink(this.forWrite().f, sessionId, t, title, branch, new Date()))
  }

  addPr(sessionId: string, url: string): void {
    this.save(withPr(this.forWrite().f, sessionId, url))
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
