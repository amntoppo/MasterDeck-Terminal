import { homedir } from 'node:os'
import {
  MATCH_FAILED,
  candidatesOf,
  checkAnswer,
  matchIndexes,
  matchPrompt,
  meetingNoteBody,
  meetingWhen,
  mergeAnswers,
  transcriptParts,
  type Answer,
  type Candidate,
} from '@shared/meetingMatch'
import { MEETING_ERROR_MAX, MEETING_TITLE_MAX, type Meeting, type MeetingMatch, type MeetingNotice } from '@shared/meetings'
import type { NoteLinkInput, NoteMeta } from '@shared/notes'
import { sameTicket } from '@shared/ticket'
import type { AppState } from '@shared/types'
import type { NotesStore } from '../notes'
import type { RunResult } from '../run'
import type { MeetingStore } from './store'

/** Sonnet reads a long transcript well; one call per part. */
export const MATCH_MODEL = 'sonnet'
export const MATCH_TIMEOUT_MS = 5 * 60_000
/** How long matching waits for MasterDeck's first session list (a meeting finished right after a start). */
const STATE_TRIES = 20
const STATE_WAIT_MS = 15_000

export interface MatcherDeps {
  store: Pick<MeetingStore, 'get' | 'update'>
  notes: Pick<NotesStore, 'addMeetingNote' | 'dropMeetingNotes' | 'meetingNotes' | 'get'>
  /** The latest AppState once the session list was read; null before. */
  state(): AppState | null
  /** One `claude -p` (main/claudeOnce.ts in the app; a fake in tests): the prompt in, Claude's text out. */
  claude(o: { model: string; prompt: string; timeoutMs: number }): Promise<RunResult>
  /** Needs you: notes added, or the meeting could not be matched. */
  notice(n: MeetingNotice): void
  onChange?(id: string): void
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x1f\x7f-\x9f]/g

/** A failure in plain words: one line, no home folder, short enough for the meeting file and Needs you. */
export function matchReason(raw: string): string {
  const home = homedir()
  const text = (home ? raw.split(home).join('~') : raw).replace(CONTROLS, ' ').replace(/\s+/g, ' ').trim()
  return (text || 'unknown error').slice(0, MEETING_ERROR_MAX - MATCH_FAILED.length)
}

const sameLink = (a: NoteLinkInput | null | undefined, b: NoteLinkInput): boolean =>
  !!a && (a.session && b.session ? a.session.key === b.session.key : !a.session && !b.session && !!a.ticket && !!b.ticket && sameTicket(a.ticket, b.ticket))

/**
 * Matching (spec §4, §5): once a meeting is all text (`matching`), one `claude -p` per part of its
 * transcript finds what was said about each candidate; the answer is checked (shared/meetingMatch);
 * the title (unless the user named it), the summary and the matches are written to the meeting, and
 * each match becomes a note about its session or ticket. One meeting at a time.
 *
 * Before writing notes it removes this meeting's notes the user never edited (a run cut short by a
 * quit, or Match again), and goes no further if one of them could not be removed; edited ones stay,
 * and a candidate that has one gets no second note. A failed or empty run leaves the meeting
 * `failed` with MATCH_FAILED and a Needs-you item (Match again); nothing is guessed.
 */
export class Matcher {
  private chain: Promise<void> = Promise.resolve()
  private queued = new Set<string>()
  private stopped = false

  constructor(private d: MatcherDeps) {}

  /** The transcriber handed over a meeting in `matching`. */
  match(id: string): Promise<void> {
    if (this.stopped || this.queued.has(id)) return this.chain
    this.queued.add(id)
    this.chain = this.chain.then(async () => {
      try {
        await this.run(id)
      } catch (e) {
        this.fail(id, String(e))
      } finally {
        this.queued.delete(id)
      }
    })
    return this.chain
  }

  /** Match again (the Meetings page, Needs you): a meeting that is done, or whose matching failed. */
  rematch(id: string): { ok: true } | { ok: false; message: string } {
    if (this.stopped) return { ok: false, message: 'MasterDeck is quitting.' }
    const m = this.d.store.get(id)
    if (!m) return { ok: false, message: 'No such meeting.' }
    if (m.state === 'matching' || this.queued.has(id)) return { ok: false, message: 'The meeting is being matched.' }
    const matchFailed = m.state === 'failed' && !!m.error?.startsWith(MATCH_FAILED)
    if (m.state !== 'done' && !matchFailed)
      return { ok: false, message: m.state === 'failed' ? 'Its transcription failed: try that again first.' : 'The meeting is not transcribed yet.' }
    // Its notes stay until Claude has answered: write() replaces them, so a failed run loses nothing.
    const u = this.d.store.update(id, (x) => ({ ...x, state: 'matching', error: null }))
    if (!u.ok) return u
    this.d.onChange?.(id)
    void this.match(id)
    return { ok: true }
  }

  /** Quitting: nothing more starts. A meeting left `matching` is matched at the next start. */
  stop(): void {
    this.stopped = true
  }

  private async readyState(): Promise<AppState | null> {
    const wait = this.d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    for (let i = 0; i < STATE_TRIES && !this.stopped; i++) {
      const s = this.d.state()
      if (s) return s
      await wait(STATE_WAIT_MS)
    }
    return null
  }

  private fail(id: string, why: string): void {
    const reason = matchReason(why)
    const u = this.d.store.update(id, (x) => ({ ...x, state: 'failed', error: `${MATCH_FAILED}${reason}` }))
    if (!u.ok) return
    this.d.onChange?.(id)
    this.d.notice({ meetingId: id, title: u.meeting.title, at: (this.d.now ?? Date.now)(), kind: 'unmatched', reason })
  }

  private async run(id: string): Promise<void> {
    if (this.stopped) return
    const m = this.d.store.get(id)
    if (!m || m.state !== 'matching') return
    if (!m.segments.length) {
      // Nothing was said: nothing to match, nothing to ask.
      this.d.store.update(id, (x) => ({ ...x, state: 'done', matches: [] }))
      this.d.onChange?.(id)
      return
    }
    const state = await this.readyState()
    if (this.stopped) return
    if (!state) return this.fail(id, 'MasterDeck has not read its sessions yet.')
    const candidates = candidatesOf(state)
    const parts = transcriptParts(m.segments)
    const answers: Answer[] = []
    for (const [n, p] of parts.entries()) {
      const r = await this.d.claude({ model: MATCH_MODEL, prompt: matchPrompt(candidates, m.segments, { ...p, n: n + 1, of: parts.length }), timeoutMs: MATCH_TIMEOUT_MS })
      // Quitting: the meeting stays `matching`, and the next start matches it.
      if (this.stopped) return
      if (r.code !== 0) return this.fail(id, r.code === -2 ? 'Claude took longer than 5 minutes.' : (r.stderr || r.stdout || `claude exited ${r.code}`).slice(0, 1000))
      if (!r.stdout.trim()) return this.fail(id, 'Claude gave no answer.')
      const c = checkAnswer(r.stdout, candidates, p)
      if (!c.ok) return this.fail(id, c.reason)
      if (c.dropped) console.error(`meetings: ${c.dropped} match(es) in Claude's answer were not valid and were left out`)
      answers.push(c.answer)
    }
    await this.write(m, candidates, mergeAnswers(answers))
  }

  private async write(m: Meeting, candidates: Candidate[], answer: Answer): Promise<void> {
    const id = m.id
    const drop = this.d.notes.dropMeetingNotes(id, true)
    if (drop.failed.length) return this.fail(id, 'Could not remove the notes it added before.')
    // The title as it is now: the user may have named it while Claude read.
    const now = this.d.store.get(id)
    if (!now || now.state !== 'matching') return
    const title = now.titleBy === 'user' || !answer.title ? now.title : answer.title.slice(0, MEETING_TITLE_MAX)
    const noteTitle = title || `Meeting ${meetingWhen(m.started)}`
    const kept: NoteMeta[] = this.d.notes.meetingNotes(id)
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const matches: MeetingMatch[] = []
    let sessions = 0
    let tickets = 0
    for (const a of answer.matches) {
      const c = byId.get(a.candidate)
      if (!c) continue
      const segments = matchIndexes(a, m.segments.length)
      // An edited note from an earlier run is the user's now: no second note beside it.
      const had = kept.find((k) => sameLink(k.link as NoteLinkInput | null | undefined, c.link))
      if (had) {
        matches.push({ label: c.label, noteId: had.id, segments })
        continue
      }
      const r = this.d.notes.addMeetingNote({
        title: noteTitle,
        body: meetingNoteBody({ meeting: { id, title: noteTitle, started: m.started }, match: a, segments: m.segments }),
        link: c.link,
        meeting: { id, title: noteTitle.slice(0, MEETING_TITLE_MAX), at: m.started },
      })
      if (!r.ok) console.error(`meetings: a note for ${c.id} was not written: ${'message' in r ? r.message : 'conflict'}`)
      const noteId = r.ok && 'meta' in r ? r.meta.id : null
      if (noteId && c.kind === 'session') sessions++
      else if (noteId) tickets++
      matches.push({ label: c.label, noteId, segments })
    }
    const u = this.d.store.update(id, (x) => ({
      ...x,
      title: x.titleBy === 'user' ? x.title : title,
      titleBy: x.titleBy === 'user' ? 'user' : title ? 'claude' : x.titleBy,
      summary: answer.summary,
      matches,
      state: 'done',
      error: null,
    }))
    if (!u.ok) return this.fail(id, u.message)
    this.d.onChange?.(id)
    if (sessions + tickets) this.d.notice({ meetingId: id, title: u.meeting.title, at: (this.d.now ?? Date.now)(), kind: 'added', sessions, tickets })
  }
}
