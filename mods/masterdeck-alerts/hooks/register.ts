import type { EngineInterface, Register } from 'claude-code'

import { bandEvents } from './alerts'
import { deckFolder, deckRead, isOff, type Band, type DeckRead } from './deck'

/*
 * Toasts in the session for what MasterDeck sees change about it: the card moves, a review thread
 * opens, CI fails or passes, the PR merges or is linked. It compares two reads of
 * `deck/band/<sessionId>.json` (the app writes it; this mod never calls GitHub). Switched off for
 * the session in Session details → Mods, it toasts nothing, and nothing when switched on again.
 */

const NAME = 'masterdeck-alerts'
const READ_MS = 2_000

let deck = ''
// The first read after a (re)load toasts nothing.
let last: Band | null | undefined

/** Read `deck/alive` and this session's band file (see deckRead in ./deck). */
async function readDeck($: EngineInterface): Promise<DeckRead> {
  if (!deck) deck = deckFolder(await $.env.get('MASTERDECK_HOME'), await $.env.get('HOME'))
  const sid = await $.session.id()
  const alive = `${deck}/alive`
  const band = `${deck}/band/${sid}.json`
  try {
    const aliveAt = (await $.fs.exists(alive)) ? (await $.fs.stat(alive)).mtimeMs : null
    const text = aliveAt !== null && (await $.fs.exists(band)) ? await $.fs.read(band) : null
    return deckRead(aliveAt, await $.clock.now(), text)
  } catch {
    return deckRead(null, 0, null)
  }
}

async function check($: EngineInterface): Promise<void> {
  const { band } = await readDeck($)
  const next = isOff(band, NAME) ? null : band
  if (last !== undefined) for (const text of bandEvents(last, next)) $.ui.toast(text)
  last = next
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    deck = deckFolder(await $.env.get('MASTERDECK_HOME'), await $.env.get('HOME'))
    await check($)
    $.clock.every(READ_MS, () => check($).catch(() => {}))
    return next(e)
  })
}
