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
/** However fast the keys come, a save goes out this long after the first unsaved one at the latest. */
export const SAVE_MAX_WAIT_MS = 2000
export const SAVE_RETRY_MS = 5000

export const draftOf = (n: Note): NoteDraft => ({ id: n.id, ticket: n.ticket, title: n.title, body: n.body, base: n.updated, dirty: false })
export const blankDraft = (ticket: Ticket | null): NoteDraft => ({ id: null, ticket, title: '', body: '', base: null, dirty: false })

/** What the panel can be asked to show. {}: the list alone. `fresh` is a timestamp: two requests for a new note differ. */
export type NoteTarget = { id?: string; ticket?: Ticket; fresh?: number }

/** One string per target ('' is the list alone). */
export function noteTargetKey(t: NoteTarget): string {
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
 * Two failures are kept apart. A save that got no answer (the line is down), or that the store could not write to
 * disk (`retry`), is tried again on a timer. A save the store refused with a reason (the limit of notes, a character
 * it does not take) would get the same answer for ever: it is tried again only when the text changes or the user
 * leaves, and the user may discard the text instead.
 */
export class NoteEditor {
  draft: NoteDraft | null = null
  clash: NoteClash | null = null
  status = ''
  /** The store's reason for refusing the text as it is; null when it has not. */
  refused: string | null = null
  /** The user tried to leave (another note, closing the panel) and the refused text kept the draft open. */
  stayed = false
  /** What the draft was opened for: where the panel goes back to when it cannot leave the draft. */
  target: NoteTarget = {}
  /** `target` as one string (noteTargetKey). */
  key = ''
  /** Grows when a save or delete ends or the draft is replaced: the list's row is worth another look (`seen`). */
  rev = 0
  /** Something on screen changed. */
  onChange: () => void = () => {}
  /** A write of its own, for the list, without waiting for the store's event. */
  onApplied: (c: NoteChange) => void = () => {}

  /** A save or delete of its own, in flight. */
  private saving: Promise<unknown> | null = null
  /** The text the store refused: sent again only once it differs (or the user leaves). */
  private refusedText: { title: string; body: string } | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** When the first key not yet sent was typed; null when everything typed was sent. */
  private waitingSince: number | null = null
  /** Names the draft: an answer for one that was replaced meanwhile is not applied to the next. */
  private serial = 0
  /** Names the newest `show`: an older one still waiting gives way. */
  private turn = 0

  constructor(private deps: NoteEditorDeps) {}

  private later(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.saveNow(), ms)
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Nothing typed is waiting any more: the draft was replaced by a stored text, or closed. */
  private settled(): void {
    this.stopTimer()
    this.waitingSince = null
  }

  /** No save or delete of its own is on its way any more. */
  private async idle(): Promise<void> {
    while (this.saving) await this.saving.catch(() => {})
  }

  /** The store has nothing against the text any more (it took it, or the text is gone). */
  private accepted(): void {
    this.refused = null
    this.refusedText = null
    this.stayed = false
  }

  private replace(d: NoteDraft | null, target: NoteTarget): void {
    this.settled()
    this.draft = d
    this.target = target
    this.key = noteTargetKey(target)
    this.clash = null
    this.status = ''
    this.accepted()
    this.serial++
    this.rev++
    this.onChange()
  }

  /** The open note as it is stored, in place of what was typed (the user's choice: Reload, Discard). */
  private restore(n: Note): void {
    this.settled()
    // The whole note, id and ticket too: a draft never saved (a ticket's, met by a note made elsewhere) is that note now.
    this.draft = draftOf(n)
    this.clash = null
    this.status = ''
    this.accepted()
    this.rev++
    this.onChange()
  }

  edit(patch: Partial<Pick<NoteDraft, 'title' | 'body'>>): void {
    if (!this.draft) return
    this.draft = { ...this.draft, ...patch, dirty: true }
    this.status = ''
    this.stayed = false
    // Half a second after the last key, but never later than the max wait after the first: typing without a pause
    // must not mean saving nothing.
    const now = Date.now()
    this.waitingSince ??= now
    this.later(Math.max(0, Math.min(SAVE_AFTER_MS, this.waitingSince + SAVE_MAX_WAIT_MS - now)))
    this.onChange()
  }

  /**
   * Save what is typed, unless a save is on its way (its end sends the rest), the user has a choice to make,
   * or the store already refused this very text.
   */
  saveNow(): void {
    const d = this.draft
    const no = this.refusedText
    if (this.saving || (d && no && d.title === no.title && d.body === no.body)) return
    void this.send(false)
  }

  /** One save. True when the store took it. Only called with no save in flight. */
  private async send(force: boolean): Promise<boolean> {
    this.stopTimer()
    const sent = this.draft
    // While the user has not chosen between the two versions, nothing is written.
    if (!sent || !sent.dirty || (this.clash && !force)) return false
    const serial = this.serial
    this.waitingSince = null
    this.status = 'Saving…'
    this.onChange()
    // null: no answer (the call threw: the line is down). Anything else is the store's own word.
    const call = this.deps
      .save({ id: sent.id ?? undefined, title: sent.title, body: sent.body, ticket: sent.ticket, base: sent.base, force })
      .catch((): SaveResult | null => null)
    this.saving = call
    const r = await call
    this.saving = null
    this.rev++
    if (r?.ok) this.onApplied('meta' in r ? { id: r.meta.id, meta: r.meta } : { id: r.id, deleted: true })
    // The draft was dropped meanwhile (Discard, Delete): the answer is for the list only.
    if (serial !== this.serial || !this.draft) {
      if (this.draft?.dirty) this.later(SAVE_AFTER_MS)
      this.onChange()
      return !!r?.ok
    }
    // No answer, or the disk failed under the store: neither is about the text, so the same save is worth another try.
    if (!r || (!r.ok && 'retry' in r && r.retry)) {
      this.status = 'Not saved'
      this.later(SAVE_RETRY_MS)
      this.onChange()
      return false
    }
    this.draft = afterSave(sent, this.draft, r)
    if (r.ok) {
      this.accepted()
      this.clash = null
      this.status = 'meta' in r ? 'Saved' : ''
      // Typed on while the save was out.
      if (this.draft.dirty) {
        this.status = ''
        this.later(SAVE_AFTER_MS)
      }
    } else if ('conflict' in r) {
      this.accepted()
      this.clash = r.note ? { kind: 'changed', note: r.note } : { kind: 'gone' }
      this.status = ''
    } else {
      // No timer: the same text would get the same answer. The next key, or leaving, tries again.
      this.refused = r.message || 'Not saved'
      this.refusedText = { title: sent.title, body: sent.body }
      this.status = this.refused
      // Typed on while the save was out: that is other text, worth its own try.
      if (this.draft.title !== sent.title || this.draft.body !== sent.body) this.later(SAVE_AFTER_MS)
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

  /** The draft stays open because its text was refused: the editor says so, where the user is looking. */
  private stay(): void {
    if (this.refused === null || !this.draft?.dirty) return
    this.stayed = true
    this.onChange()
  }

  /** The panel closes or the window goes away: what is typed is sent. False when it could not be stored. */
  async leave(): Promise<boolean> {
    const stored = await this.flush()
    if (!stored) this.stay()
    return stored
  }

  /**
   * Show what was asked for: `load` reads it (null: the list alone). What is open is saved first.
   * False: nothing changed, because the open text could not be saved or the other note could not be read;
   * the caller goes back to `target`.
   */
  async show(target: NoteTarget, load: () => Promise<NoteDraft | null>): Promise<boolean> {
    const turn = ++this.turn
    const key = noteTargetKey(target)
    if (key === this.key) return true
    // Saved before the read: a target that is the open note under another name is then read as it is now.
    if (!(await this.flush())) {
      if (turn !== this.turn) return true
      this.stay()
      return false
    }
    if (turn !== this.turn) return true
    let next: NoteDraft | null
    try {
      next = await load()
    } catch {
      if (turn !== this.turn) return true
      this.status = 'Could not open the note'
      this.onChange()
      return false
    }
    // Again, for what was typed during the read. This flush is the last thing waited for: nothing can be typed
    // between its answer and the swap.
    const stored = await this.flush()
    if (turn !== this.turn) return true
    if (!stored) {
      this.stay()
      return false
    }
    // The open note under another name (a new draft, saved, then picked in the list): the editor has the newer text.
    if (next?.id && next.id === this.draft?.id) {
      this.target = target
      this.key = key
      this.onChange()
      return true
    }
    this.replace(next, target)
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
    if (this.draft && this.clash?.kind === 'changed') this.restore(this.clash.note)
  }

  /** The user keeps what is typed: it is written over the other version (or again, when the note was deleted). */
  async keepMine(): Promise<void> {
    await this.idle()
    if (!this.draft || !this.clash) return
    this.draft = { ...this.draft, dirty: true }
    await this.send(true)
  }

  /** The user drops the draft. */
  drop(): void {
    this.turn++
    this.replace(null, {})
  }

  /**
   * The user drops text the store refused: a stored note is shown as it is stored, a draft never saved closes
   * (`draft` is null then).
   */
  async discardUnsaved(): Promise<void> {
    await this.idle()
    const d = this.draft
    // The save that was out may have been taken after all: nothing is left to discard.
    if (!d || this.refused === null) return
    if (!d.id || d.base === null) return this.drop()
    const serial = this.serial
    let n: Note | null
    try {
      n = await this.deps.get(d.id)
    } catch {
      this.status = 'Could not read the note'
      return this.onChange()
    }
    if (serial !== this.serial) return
    if (n) this.restore(n)
    else this.drop()
  }

  /**
   * Delete the open note. `ask` is the question before it, for a stored note (the web's; the desktop's is the
   * store's own, which answers 'cancelled'). True when the draft is gone.
   * Whatever is waited for, it is the note open at the click that goes: when another was opened meanwhile, nothing does.
   */
  async remove(del: (id: string) => Promise<{ ok: boolean; message?: string }>, ask: () => Promise<boolean> = async () => true): Promise<boolean> {
    const serial = this.serial
    // A first save on its way gives the draft its id: wait, or the note would be stored after it was "deleted".
    await this.idle()
    const d = this.draft
    if (!d || serial !== this.serial) return false
    if (!d.id || d.base === null) {
      this.drop()
      return true
    }
    const id = d.id
    if (!(await ask())) return false
    await this.idle()
    if (serial !== this.serial || this.draft?.id !== id) return false
    this.stopTimer()
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
