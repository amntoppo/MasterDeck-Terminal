/*
 * MasterDeck's messages, handed to the session without typing (#123): MasterDeck writes
 * `deck/deliver/<sessionId>/<id>.json`; the core claims it (`<id>.claim`), MasterDeck answers
 * `<id>.go` when the claim came in time, and only then the core submits it, once, and writes
 * `<id>.done` (`<id>.skip` when no go came: never submitted). `$.fs` can neither rename nor
 * delete, so MasterDeck alone decides who delivers (it removes the files); a request this load did
 * not claim itself is never submitted.
 */

const ID = /^[0-9]+-[0-9a-z]+$/

/** Requests nobody claimed yet, oldest first (ids are `<ms>-<n>`). */
export function toClaim(names: readonly string[]): string[] {
  const has = new Set(names)
  return names
    .filter(n => n.endsWith('.json'))
    .map(n => n.slice(0, -5))
    .filter(id => ID.test(id) && !has.has(`${id}.claim`) && !has.has(`${id}.done`))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || (a < b ? -1 : 1))
}

/** A request's text, when the file is one (v1, a non-empty string under 64 KiB). */
export function requestText(text: string): string | null {
  try {
    const o = JSON.parse(text) as { v?: unknown; text?: unknown }
    return o && o.v === 1 && typeof o.text === 'string' && o.text.trim() && o.text.length < 65_536 ? o.text : null
  } catch {
    return null
  }
}
