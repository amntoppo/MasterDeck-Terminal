import { describe, it, expect } from 'vitest'
import { filterNotes, isNoteFilter, meetingDay, meetingDot, newestMeetingNote, noteIn, sessionLink, shownNote } from './noteFilter'
import { noteMeta, type Note, type NoteMeta } from './notes'

const meta = (id: string, over: Partial<Note> = {}): NoteMeta =>
  noteMeta({ id: `n-${id.padEnd(32, '0')}`, title: id, body: '', ticket: null, created: 10, updated: 20, ...over })
const meeting = { id: 'm-' + 'a'.repeat(32), title: 'Standup', at: 5 }

const mine = meta('1')
const ticketNote: NoteMeta = { ...meta('2'), id: 't-acme~web~12', ticket: { repo: 'acme/web', number: 12 } }
const aboutTicket = meta('3', { link: { ticket: { repo: 'acme/web', number: 12 } } })
const aboutSession = meta('4', { link: { session: { key: 'bg-1', name: 'login' } } })
const fromMeeting = meta('5', { link: { session: { key: 'bg-1', name: 'login' }, ticket: { repo: 'acme/web', number: 12 } }, meeting })
const all = [mine, ticketNote, aboutTicket, aboutSession, fromMeeting]
const ids = (l: NoteMeta[]) => l.map((m) => m.title)

describe('the Notes filters', () => {
  it('All keeps everything, in order', () => {
    expect(filterNotes(all, 'all')).toEqual(all)
  })
  it('Mine is the notes about nothing', () => {
    expect(ids(filterNotes(all, 'mine'))).toEqual(['1'])
  })
  it('Tickets: a ticket note and a note about a ticket', () => {
    expect(ids(filterNotes(all, 'tickets'))).toEqual(['2', '3', '5'])
  })
  it('Sessions and Meetings', () => {
    expect(ids(filterNotes(all, 'sessions'))).toEqual(['4', '5'])
    expect(ids(filterNotes(all, 'meetings'))).toEqual(['5'])
  })
  it('a meeting note alone is not Mine', () => {
    expect(noteIn(meta('6', { meeting }), 'mine')).toBe(false)
  })
  it('a stored choice is checked', () => {
    expect(isNoteFilter('sessions')).toBe(true)
    expect(isNoteFilter('x')).toBe(false)
    expect(isNoteFilter(null)).toBe(false)
  })
})

describe('the meeting dot', () => {
  const m1 = meta('a', { meeting, created: 100 })
  const m2 = meta('b', { meeting, created: 300 })
  const plain = meta('c', { created: 900 })
  it('the newest meeting note, never another note', () => {
    expect(newestMeetingNote([m1, plain, m2])).toBe(300)
    expect(newestMeetingNote([plain])).toBe(0)
  })
  it('shows for a meeting note newer than what was seen', () => {
    expect(meetingDot([m1, m2], null)).toBe(true)
    expect(meetingDot([m1, m2], 100)).toBe(true)
    expect(meetingDot([m1, m2], 300)).toBe(false)
    expect(meetingDot([plain], null)).toBe(false)
  })
})

describe('sessionLink', () => {
  it('the session and its ticket', () => {
    expect(sessionLink({ key: 'bg-1', name: 'login' }, { repo: null, number: 3 })).toEqual({
      session: { key: 'bg-1', name: 'login' },
      ticket: { repo: null, number: 3 },
    })
  })
  it('a name made safe for one line, cut to the limit', () => {
    expect(sessionLink({ key: 'bg-1', name: `a\tb${'x'.repeat(300)}` }, null)?.session?.name).toHaveLength(200)
    expect(sessionLink({ key: 'bg-1', name: 'a\nb' }, null)?.session?.name).toBe('a b')
    expect(sessionLink({ key: 'bg-1', name: 'a\nb\tc\x7fd' }, null)?.session?.name).toBe('a b c d')
  })
  it('a key the store would refuse leaves the session out', () => {
    expect(sessionLink({ key: 'a b', name: 'x' }, { repo: null, number: 3 })).toEqual({ ticket: { repo: null, number: 3 } })
    expect(sessionLink({ key: 'a b', name: 'x' }, null)).toBeUndefined()
  })
})

describe('shownNote', () => {
  it('the first note until one is picked', () => {
    expect(shownNote(all, null)).toBe(mine)
    expect(shownNote([], null)).toBeNull()
  })
  it('the picked note stays when a newer one comes first', () => {
    expect(shownNote([fromMeeting, ...all], aboutSession.id)).toBe(aboutSession)
  })
  it('the first again when the picked note is gone', () => {
    expect(shownNote([ticketNote, mine], aboutSession.id)).toBe(ticketNote)
  })
})

describe('meetingDay', () => {
  it('day and short month', () => {
    expect(meetingDay(new Date(2026, 9, 9, 12).getTime())).toBe('9 Oct')
  })
})
