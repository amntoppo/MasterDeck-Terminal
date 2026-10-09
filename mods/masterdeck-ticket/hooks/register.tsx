import type { EngineInterface, Register } from 'claude-code'

import { deckFolder, deckRead, isOff, type DeckRead } from './deck'
import { NARROW_COLS, segments } from './line'

/*
 * The session's MasterDeck ticket above the prompt: the ticket, its board column, the PR (CI, open
 * threads) and linked sessions, from `deck/band/<sessionId>.json`, which the app writes; this mod
 * never calls GitHub. **Details** and /md-ticket open a pane with the links. Nothing is drawn where
 * MasterDeck has no band for the session, or while this mod is switched off for it in Session
 * details → Mods (it reads that from the band itself, so the switch acts at once).
 * What it draws comes from module variables: a reload starts them over and the next read (2 s,
 * and one at once at session.start) fills them again.
 */

const NAME = 'masterdeck-ticket'
const PANE = 'md-ticket'
const READ_MS = 2_000

let deck = ''
let now: DeckRead = { band: null, isOffline: false, lastAliveAt: 0 }
let isHidden = false

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

async function refresh($: EngineInterface): Promise<void> {
  const next = await readDeck($)
  const changed = JSON.stringify(next) !== JSON.stringify(now)
  now = next
  if (isOff(next.band, NAME) && (await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  if (changed) $.ui.invalidate('ui.render')
}

/** Nothing to show: no band, or switched off here. */
const isQuiet = () => !now.band || isOff(now.band, NAME)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    deck = deckFolder(await $.env.get('MASTERDECK_HOME'), await $.env.get('HOME'))
    await $.command.register({ name: 'md-ticket', description: 'Show this session\'s MasterDeck ticket in a pane' })
    await refresh($)
    $.clock.every(READ_MS, () => refresh($).catch(() => {}))
    return next(e)
  })

  // Switched off here: answer with nothing, so the transcript shows nothing.
  on('command.run', { command: 'md-ticket' }, async $ => {
    if (isOff(now.band, NAME)) return {}
    isHidden = false
    $.ui.invalidate('ui.render')
    if (!now.band) return { text: 'MasterDeck has no ticket, PR or linked session for this session.' }
    await $.ui.open({ id: PANE, title: 'MasterDeck' })
    return { text: 'Opened the ticket pane.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = now.band
    if (!b || isQuiet() || e.props.hasSurvey || isHidden) return next(e)
    const cols = e.props.bodyColumns ?? NARROW_COLS
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = segments(b, cols, now.isOffline ? (await $.clock.now()) - now.lastAliveAt : null)
    const isNarrow = cols < NARROW_COLS
    // One line: the links live in the pane (a terminal without hyperlinks prints the whole URL).
    const ours = (
      <Box key="md-band" flexDirection="row" flexWrap="wrap" gap={1}>
        {parts.map(s => (
          <Text color={s.color} bold={s.bold} dimColor={s.dim}>{s.text}</Text>
        ))}
        <Button key="md-details" label={isNarrow ? 'More' : 'Details'} onPress={() => $.ui.open({ id: PANE, title: 'MasterDeck' })} />
        {!isNarrow && <Button key="md-hide" label="Hide" onPress={() => { isHidden = true; $.ui.invalidate('ui.render') }} />}
      </Box>
    )
    // Keep what other mods put here: ours first, theirs under it.
    const below = await next(e)
    return below ? <Box flexDirection="column">{ours}{below}</Box> : ours
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const b = now.band
    if (isOff(b, NAME)) return <Box />
    if (!b) return <Text dimColor>MasterDeck has nothing for this session.</Text>
    const pr = b.pr
    return (
      <Box flexDirection="column" gap={1}>
        {now.isOffline && <Text dimColor>MasterDeck is closed: this is what it last wrote.</Text>}
        {b.ticket ? (
          <Box flexDirection="column">
            <Text bold>{b.ticket.title ?? b.ticket.label}</Text>
            <Link href={b.ticket.url} label={b.ticket.ref} />
          </Box>
        ) : (
          <Text bold>{b.name}</Text>
        )}
        <Box flexDirection="column">
          <Text dimColor>Board</Text>
          <Text color={b.status ? 'yellow' : undefined}>{b.status ?? 'Not on a board'}</Text>
        </Box>
        {pr && (
          <Box flexDirection="column">
            <Text dimColor>Pull request</Text>
            <Link href={pr.url} label={`#${pr.number}${pr.draft ? ' (draft)' : ''}${pr.state ? ` · ${pr.state.toLowerCase()}` : ''}`} />
            <Text>
              {pr.ci === 'success' ? 'CI passing' : pr.ci === 'failure' ? 'CI failing' : pr.ci === 'pending' ? 'CI running' : 'CI not read yet'}
              {` · ${pr.threads} open thread${pr.threads === 1 ? '' : 's'}`}
            </Text>
          </Box>
        )}
        {b.peers.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Linked sessions</Text>
            {b.peers.map(p => (
              <Text>{p.name} <Text dimColor>· {p.state}</Text></Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
