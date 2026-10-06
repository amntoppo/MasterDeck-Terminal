import { incoming, type Note, type NoteChange, type NoteInput, type NoteMeta, type SaveResult } from './notes'
import { ticketKey, type Ticket } from './ticket'

/** What the editor holds: one note's text, and the stored version it started from. */
export interface NoteDraft {
  id: string | null
  ticket: Ticket | null
  title: string
  body: string
  /** The stored version this text started from; null before the first save. */
  base: number | null
  /** Text typed and not saved yet. */
  dirty: boolean
}
/** The stored note is no longer the version the typed text started from; the user picks one. */
export type NoteClash = { kind: 'changed'; note: Note } | { kind: 'gone' }

export const SAVE_AFTER_MS = 500
export const SAVE_RETRY_MS = 5000

export const draftOf = (n: Note): NoteDraft => ({ id: n.id, ticket: n.ticket, title: n.title, body: n.body, base: n.updated, dirty: false })
export const blankDraft = (ticket: Ticket | null): NoteDraft => ({ id: null, ticket, title: '', body: '', base: null, dirty: false })

/** One string per thing the panel can be asked to show ('' is the list alone). `fresh` is a timestamp: two requests for a new note differ. */
export function noteTargetKey(t: { id?: string; ticket?: Ticket; fresh?: number }): string {
  if (t.id) return `i:${t.id}`
  if (t.ticket) return `t:${ticketKey(t.ticket.repo, t.ticket.number)}`
  return t.fresh ? `f:${t.fresh}` : ''
}

/** The draft once its save was answered. `sent` is what the save carried; `now` what the editor holds (the user may have typed on). */
export function afterSave(sent: NoteDraft, now: NoteDraft, r: SaveResult): NoteDraft {
  if (!r.ok) return now
  const dirty = now.title !== sent.title || now.body !== sent.body
  // A ticket note saved empty was removed: what is typed next starts a new one.
  return 'meta' in r ? { ...now, id: r.meta.id, base: r.meta.updated, dirty } : { ...now, id: null, base: null, dirty }
}

export interface NoteEditorDeps {
  save(input: NoteInput): Promise<SaveResult>
  get(id: string): Promise<Note | null>
}

/**
 * The Notes editor without its screen: the text being typed, when it is saved, and what happens when the stored note
 * moved meanwhile. The rule it keeps: typed text is dropped only by the user's own choice (Reload, Discard, Delete).
 * Anything else that would replace the draft waits until it is saved, and gives up when it cannot be.
 * It outlives the panel, so text whose save was still on its way (or failed) when the panel closed is there again
 * when it opens.
 */
export class NoteEditor {
  draft: NoteDraft | null = null
  clash: NoteClash | null = null
  status = ''
  /** What the draft was opened for (noteTargetKey). */
  key = ''
  /** Grows when a save or delete ends or the draft is replaced: the list's row is worth another look (`seen`). */
  rev = 0
  /** Something on screen changed. */
  onChange: () => void = () => {}
  /** A write of its own, for the list, without waiting for the store's event. */
  onApplied: (c: NoteChange) => void = () => {}

  /** A save or delete of its own, in flight. */
  private saving: Promise<unknown> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Names the draft: an answer for one that was replaced meanwhile is not applied to the next. */
  private serial = 0
  /** Names the newest `show`: an older one still waiting gives way. */
  private turn = 0

  constructor(private deps: NoteEditorDeps) {}

  private later(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), ms)
  }

  private replace(d: NoteDraft | null, key: string): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.draft = d
    this.key = key
    this.clash = null
    this.status = ''
    this.serial++
    this.rev++
    this.onChange()
  }

  edit(patch: Partial<Pick<NoteDraft, 'title' | 'body'>>): void {
    if (!this.draft) return
    this.draft = { ...this.draft, ...patch, dirty: true }
    this.status = ''
    this.later(SAVE_AFTER_MS)
    this.onChange()
  }

  /** Save what is typed, unless a save is on its way (its end sends the rest) or the user has a choice to make. */
  saveNow(): void {
    if (!this.saving) void this.send(false)
  }

  /** One save. True when the store took it. Only called with no save in flight. */
  private async send(force: boolean): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const sent = this.draft
    // While the user has not chosen between the two versions, nothing is written.
    if (!sent || !sent.dirty || (this.clash && !force)) return false
    const serial = this.serial
    this.status = 'Saving…'
    this.onChange()
    const call = this.deps
      .save({ id: sent.id ?? undefined, title: sent.title, body: sent.body, ticket: sent.ticket, base: sent.base, force })
      .catch((): SaveResult => ({ ok: false, message: 'Not saved' }))
    this.saving = call
    const r = await call
    this.saving = null
    this.rev++
    if (r.ok) this.onApplied('meta' in r ? { id: r.meta.id, meta: r.meta } : { id: r.id, deleted: true })
    // The draft was dropped meanwhile (Discard, Delete): the answer is for the list only.
    if (serial !== this.serial || !this.draft) {
      if (this.draft?.dirty) this.later(SAVE_AFTER_MS)
      this.onChange()
      return r.ok
    }
    this.draft = afterSave(sent, this.draft, r)
    if (r.ok) {
      this.clash = null
      this.status = 'meta' in r ? 'Saved' : ''
      // Typed on while the save was out.
      if (this.draft.dirty) {
        this.status = ''
        this.later(SAVE_AFTER_MS)
      }
    } else if ('conflict' in r) {
      this.clash = r.note ? { kind: 'changed', note: r.note } : { kind: 'gone' }
      this.status = ''
    } else {
      this.status = r.message || 'Not saved'
      this.later(SAVE_RETRY_MS)
    }
    this.onChange()
    return r.ok
  }

  /** Everything typed is stored. False when it cannot be right now (a failed save, a choice the user has to make). */
  async flush(): Promise<boolean> {
    for (;;) {
      if (this.saving) {
        await this.saving.catch(() => {})
        continue
      }
      if (!this.draft?.dirty) return true
      if (this.clash) return false
      if (!(await this.send(false))) return false
    }
  }

  /**
   * Show what was asked for: `load` reads it (null: the list alone). What is open is saved first.
   * False: nothing changed, because the open text could not be saved or the other note could not be read;
   * the caller goes back to `key`.
   */
  async show(key: string, load: () => Promise<NoteDraft | null>): Promise<boolean> {
    const turn = ++this.turn
    if (key === this.key) return true
    let next: NoteDraft | null
    try {
      next = await load()
    } catch {
      if (turn === this.turn) {
        this.status = 'Could not open the note'
        this.onChange()
      }
      return turn !== this.turn
    }
    // The flush is the last thing waited for: nothing can be typed between its answer and the swap.
    const stored = await this.flush()
    if (turn !== this.turn) return true
    if (!stored) return false
    this.replace(next, key)
    return true
  }

  /** A `show` still waiting gives way (the panel closed). */
  cancelShow(): void {
    this.turn++
  }

  /** The list's row for the open note (undefined: none): it may have changed somewhere else. */
  seen(meta: NoteMeta | undefined, loaded: boolean): void {
    const d = this.draft
    if (!d || this.clash) return
    const what = incoming({ id: d.id, base: d.base, dirty: d.dirty, saving: !!this.saving, loaded }, meta)
    if (what === 'gone') {
      this.clash = { kind: 'gone' }
      return this.onChange()
    }
    if (what !== 'reload' && what !== 'ask') return
    const serial = this.serial
    void this.deps
      .get(d.id!)
      .then((n) => {
        const cur = this.draft
        // A save of its own started meanwhile: its answer settles it (a conflict, if the note did change).
        if (serial !== this.serial || !cur || !n || this.clash || this.saving || cur.base === n.updated) return
        // Typed since the look: the text stays, the user chooses.
        if (cur.dirty) this.clash = { kind: 'changed', note: n }
        else this.draft = { ...cur, title: n.title, body: n.body, base: n.updated }
        this.onChange()
      })
      .catch(() => {})
  }

  /** The user takes the other version. */
  reload(): void {
    if (!this.draft || this.clash?.kind !== 'changed') return
    const n = this.clash.note
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.draft = { ...this.draft, title: n.title, body: n.body, base: n.updated, dirty: false }
    this.clash = null
    this.status = ''
    this.onChange()
  }

  /** The user keeps what is typed: it is written over the other version (or again, when the note was deleted). */
  async keepMine(): Promise<void> {
    while (this.saving) await this.saving.catch(() => {})
    if (!this.draft || !this.clash) return
    this.draft = { ...this.draft, dirty: true }
    await this.send(true)
  }

  /** The user drops the draft. */
  drop(): void {
    this.turn++
    this.replace(null, '')
  }

  /**
   * Delete the open note. `del` asks the store (which may ask the user and answer 'cancelled').
   * True when the draft is gone.
   */
  async remove(del: (id: string) => Promise<{ ok: boolean; message?: string }>): Promise<boolean> {
    // A first save on its way gives the draft its id: wait, or the note would be stored after it was "deleted".
    while (this.saving) await this.saving.catch(() => {})
    const d = this.draft
    if (!d) return false
    if (!d.id || d.base === null) {
      this.drop()
      return true
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const serial = this.serial
    const id = d.id
    const call = del(id).catch(() => ({ ok: false, message: 'Not deleted' }))
    // Held as a save is: nothing is written, and the list's change is not taken for someone else's.
    this.saving = call
    const r: { ok: boolean; message?: string } = await call
    this.saving = null
    this.rev++
    if (r.ok) {
      this.onApplied({ id, deleted: true })
      const same = serial === this.serial
      if (same) this.drop()
      else this.onChange()
      return same
    }
    if (serial === this.serial && this.draft) {
      if (r.message !== 'cancelled') this.status = r.message || 'Not deleted'
      if (this.draft.dirty) this.later(SAVE_AFTER_MS)
    }
    this.onChange()
    return false
  }
}
