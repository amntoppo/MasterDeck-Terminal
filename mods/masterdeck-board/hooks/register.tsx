import type { EngineInterface, Register } from 'claude-code'

import { boardHeading, columnHeading, moreText, parseBoard, type Board } from './board'
import { deckFolder, deckRead, isOff, type DeckRead } from './deck'

/*
 * /md-board: the board of this session's account in a pane, read only, this session's ticket
 * marked. MasterDeck writes it (`deck/boards/<key>.json`, the band's `boardKey` says which); this mod
 * never calls GitHub. Switched off for the session in Session details → Mods, the command answers
 * with nothing and an open pane closes.
 */

const NAME = 'masterdeck-board'
const PANE = 'md-board'
const READ_MS = 5_000

let deck = ''
let now: DeckRead = { band: null, isOffline: false, lastAliveAt: 0 }
let board: Board | null = null

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

/** Read the band and the board it names; redraw the pane when either changed. */
async function refresh($: EngineInterface): Promise<void> {
  const next = await readDeck($)
  let nextBoard: Board | null = null
  const key = next.band?.boardKey
  if (key && /^(?:_|[A-Za-z0-9-]{1,39})$/.test(key)) {
    try {
      const path = `${deck}/boards/${key}.json`
      if (await $.fs.exists(path)) nextBoard = parseBoard(await $.fs.read(path))
    } catch {
      nextBoard = null
    }
  }
  const changed = JSON.stringify([next, nextBoard]) !== JSON.stringify([now, board])
  now = next
  board = nextBoard
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen && isOff(next.band, NAME)) await $.ui.close({ id: PANE })
  else if (changed) $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    deck = deckFolder(await $.env.get('MASTERDECK_HOME'), await $.env.get('HOME'))
    await $.command.register({ name: 'md-board', description: 'Show the board of this session\'s account in a pane (read only)' })
    await refresh($)
    $.clock.every(READ_MS, () => refresh($).catch(() => {}))
    return next(e)
  })

  // Switched off here: answer with nothing, so the transcript shows nothing.
  on('command.run', { command: 'md-board' }, async $ => {
    await refresh($)
    if (isOff(now.band, NAME)) return {}
    if (now.isOffline && !board) return { text: 'MasterDeck is not running, and it has not written a board for this session.' }
    if (!board) return { text: 'MasterDeck has no board for this session\'s account yet.' }
    await $.ui.open({ id: PANE, title: 'Board' })
    return { text: 'Opened the board.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    if (isOff(now.band, NAME)) return <Box />
    if (!board) return <Text dimColor>MasterDeck has no board for this session's account yet.</Text>
    const mine = now.band?.ticket?.url ?? null
    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{boardHeading(board)}{now.isOffline ? ' · MasterDeck is closed: as it last wrote' : ''}</Text>
        {board.columns.map(c => (
          <Box key={c.name} flexDirection="column">
            <Text bold>{columnHeading(c)}</Text>
            {c.cards.map(card => (
              <Text key={card.url} color={card.url === mine ? 'cyan' : undefined} bold={card.url === mine}>
                {card.url === mine ? '▸ ' : '  '}{card.label} {card.title}
                {card.assignees.length > 0 && <Text dimColor> · {card.assignees.join(', ')}</Text>}
              </Text>
            ))}
            {moreText(c) && <Text dimColor>  {moreText(c)}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
