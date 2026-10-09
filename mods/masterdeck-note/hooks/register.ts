import type { EngineInterface, Register } from 'claude-code'

import { deckFolder, deckRead, isOff, type DeckRead } from './deck'
import { noteAnswerText, noteRequestId } from './note'

/*
 * /md-note <text>: adds the text to the note of this session's ticket in MasterDeck (it owns the
 * notes), through the same pump as the masterdeck-notes skill (`note-requests/`, `note-answers/`).
 * It runs at once, without a Claude turn. Switched off for the session in Session details → Mods,
 * the command answers with nothing.
 */

const NAME = 'masterdeck-note'

let deck = ''

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

/**
 * The request is written under a name the app skips, then renamed, so the app never reads half a
 * file. ponytail: `mv`/`rm` through $.process (the mods API has no rename or delete): macOS and
 * Linux only. On Windows, use `cmd /c move` or wait for a rename in $.fs.
 */
async function addNote($: EngineInterface, text: string): Promise<string> {
  if (!text.trim()) return 'Usage: /md-note <text>. Adds the text to the note of this session\'s ticket in MasterDeck.'
  const { band, isOffline } = await readDeck($)
  if (!band?.ticket) return 'This session has no ticket in MasterDeck, so there is no ticket note to add to.'
  if (isOffline) return 'MasterDeck is not running, so nothing was saved.'
  const id = noteRequestId(await $.clock.now(), Math.random())
  const req = `${deck}/note-requests/${id}`
  const answer = `${deck}/note-answers/${id}.json`
  await $.fs.write(`${req}.part`, JSON.stringify({ op: 'ticket', arg: band.ticket.ref, body: text }))
  if ((await $.process.run(['mv', `${req}.part`, `${req}.json`])).exitCode !== 0) return 'Could not hand the note to MasterDeck.'
  // MasterDeck answers within a second while it runs; stay well inside the hook's 10 s.
  for (let i = 0; i < 30; i++) {
    if (await $.fs.exists(answer)) {
      const reply = noteAnswerText(await $.fs.read(answer))
      await $.process.run(['rm', '-f', answer])
      return reply
    }
    await $.clock.sleep(200)
  }
  // Take it back; the app claims by its own rename, so only one of us wins.
  const back = await $.process.run(['mv', `${req}.json`, `${req}.gone`])
  if (back.exitCode === 0) {
    await $.process.run(['rm', '-f', `${req}.gone`])
    return 'MasterDeck did not answer, so nothing was saved.'
  }
  return 'MasterDeck took the note but did not answer; look in Notes before writing it again.'
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    deck = deckFolder(await $.env.get('MASTERDECK_HOME'), await $.env.get('HOME'))
    await $.command.register({ name: 'md-note', description: 'Add text to this ticket\'s note in MasterDeck', argumentHint: '<text>' })
    return next(e)
  })

  // Switched off here: answer with nothing, so the transcript shows nothing.
  on('command.run', { command: 'md-note' }, async ($, e) =>
    isOff((await readDeck($)).band, NAME) ? {} : { text: await addNote($, e.args) },
  )
}
