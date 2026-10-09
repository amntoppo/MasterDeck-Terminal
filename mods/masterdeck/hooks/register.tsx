import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band, Link } from '../types'
import { ALIVE_MS, NARROW_COLS, bandEvents, isQuiet, noteAnswerText, noteRequestId, parseBand, refuses, seenWith, segments, toReload } from './band'

/*
 * MasterDeck's mod. It only reads what the app writes under `<MASTERDECK_HOME>/deck` and never
 * calls GitHub, so one app polls for every session:
 * - `band/<sessionId>.json`: the ticket, its column, the PR, linked sessions (app: shared/modBand.ts)
 * - `alive`: touched by the app every 5 s; older than 30 s means MasterDeck is closed
 * It writes `mods/<sessionId>.json` every 15 s (its heartbeat: the app shows "Mod live") and asks
 * for notes the way the masterdeck-notes skill does (`note-requests/`, `note-answers/`).
 * In a session MasterDeck has no band for it draws nothing.
 *
 * Mods switched off for a session (`offMods` in its band): this one goes quiet (nothing drawn,
 * toasted or answered); another is refused at `plugin.register`, which judges only the modules
 * that load after this one (`prependPlugins` puts it first). A mod already running stays until the
 * session starts again; one switched back on joins at a reload, which this mod asks for.
 */

// Keep in step with .claude-plugin/plugin.json.
const VERSION = '0.3.0'
const PANE = 'md-ticket'
const BEAT_MS = 15_000
const READ_MS = 2_000

const band = atom({ plugin: 'masterdeck', key: 'band' } as const, null)
const link = atom({ plugin: 'masterdeck', key: 'link' } as const, { isOffline: false, lastAliveAt: 0 })
const isHidden = atom({ plugin: 'masterdeck', key: 'isHidden' } as const, false)
// In $.state, so a reload of this module keeps what it saw (unchanged modules are not judged again).
const seen = atom({ plugin: 'masterdeck', key: 'seen' } as const, [])

// The module's own: a reload starts them over, and the first read after it toasts nothing.
let deck = ''
let sid = ''
let last: Band | null | undefined
/** Mods this load already asked a reload for (see toReload). */
const asked = new Set<string>()
let isReloading = false

async function deckDir($: EngineInterface): Promise<string> {
  const home = (await $.env.get('MASTERDECK_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.claude/masterdeck`
  return `${home}/deck`
}

/** The mods switched off for this session, read now (modules load before session.start). */
async function offModsNow($: EngineInterface): Promise<string[]> {
  if (!deck) deck = await deckDir($)
  const id = await $.session.id()
  try {
    return parseBand(await $.fs.read(`${deck}/band/${id}.json`))?.offMods ?? []
  } catch {
    return []
  }
}

async function mtime($: EngineInterface, path: string): Promise<number | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    return (await $.fs.stat(path)).mtimeMs
  } catch {
    return null
  }
}

/** Read the band and whether MasterDeck runs; redraw only when either changed. */
async function refresh($: EngineInterface): Promise<void> {
  sid = await $.session.id()
  const now = await $.clock.now()
  const aliveAt = await mtime($, `${deck}/alive`)
  const path = `${deck}/band/${sid}.json`
  const bandAt = aliveAt === null ? null : await mtime($, path)
  let next: Band | null = null
  if (bandAt !== null) {
    try {
      next = parseBand(await $.fs.read(path))
    } catch {
      next = null
    }
  }
  if (last !== undefined) for (const text of bandEvents(last, next)) $.ui.toast(text)
  last = next
  if (isQuiet(next) && (await $.ui.panes()).some(p => p.id === PANE)) await $.ui.close({ id: PANE })
  // A refused mod switched on again joins only at a reload: ask for one (queued until idle).
  const offMods = next?.offMods ?? []
  for (const name of [...asked]) if (offMods.includes(name)) asked.delete(name)
  const again = toReload(await read($, seen), offMods, asked)
  if (again.length && !isReloading) {
    for (const name of again) asked.add(name)
    isReloading = true
    void $.command.run({ command: 'reload-plugins' }).catch(() => {}).finally(() => { isReloading = false })
  }
  // `alive` moves every 5 s while the app runs: keep its time only once it stopped, so a
  // running app redraws nothing.
  const isOffline = aliveAt === null || now - aliveAt > ALIVE_MS
  const nextLink: Link = { isOffline, lastAliveAt: isOffline ? aliveAt ?? 0 : 0 }
  if (JSON.stringify(await read($, band)) !== JSON.stringify(next)) await update($, band, () => next)
  const was = await read($, link)
  if (was.isOffline !== nextLink.isOffline || was.lastAliveAt !== nextLink.lastAliveAt) await update($, link, () => nextLink)
}

/** Tell the app this session runs the mod; only where MasterDeck is installed (its deck folder). */
async function beat($: EngineInterface, isEnded = false): Promise<void> {
  if (!sid || !(await $.fs.exists(`${deck}/alive`))) return
  const claude = (await $.session.version()).version
  const mods = await read($, seen)
  await $.fs.write(`${deck}/mods/${sid}.json`, JSON.stringify({ v: 1, version: VERSION, claude, at: await $.clock.now(), mods, ...(isEnded ? { ended: true } : {}) }))
}

/**
 * Add text to this ticket's note, through MasterDeck (it owns the notes). The request is written
 * under a name the app skips, then renamed, so the app never reads half a file.
 * ponytail: `mv`/`rm` through $.process (the mods API has no rename or delete): macOS and Linux
 * only. On Windows, use `cmd /c move` or wait for a rename in $.fs.
 */
async function addNote($: EngineInterface, text: string): Promise<string> {
  if (!text.trim()) return 'Usage: /md-note <text>. Adds the text to the note of this session\'s ticket in MasterDeck.'
  const b = await read($, band)
  if (!b?.ticket) return 'This session has no ticket in MasterDeck, so there is no ticket note to add to.'
  if ((await read($, link)).isOffline) return 'MasterDeck is not running, so nothing was saved.'
  const id = noteRequestId(await $.clock.now(), Math.random())
  const req = `${deck}/note-requests/${id}`
  const answer = `${deck}/note-answers/${id}.json`
  await $.fs.write(`${req}.part`, JSON.stringify({ op: 'ticket', arg: b.ticket.ref, body: text }))
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
  // Judge each mod that loads after this one. A failed judge lets the mod in.
  on('plugin.register', async ($, e, next) => {
    const isRefused = refuses(e, await offModsNow($))
    await update($, seen, list => seenWith(list, { name: e.name, provenance: e.provenance, version: e.version ?? null, tier: e.tier, loaded: !isRefused }))
    return isRefused ? { refuse: 'switched off for this session in MasterDeck' } : next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    deck = await deckDir($)
    await $.command.register({ name: 'md-ticket', description: 'Show this session\'s MasterDeck ticket in a pane' })
    await $.command.register({ name: 'md-note', description: 'Add text to this ticket\'s note in MasterDeck', argumentHint: '<text>' })
    await refresh($)
    await beat($)
    $.clock.every(READ_MS, () => refresh($).catch(() => {}))
    $.clock.every(BEAT_MS, () => beat($).catch(() => {}))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await beat($, true).catch(() => {})
    return next(e)
  })

  // Switched off here: answer with nothing, so the transcript shows nothing.
  on('command.run', { command: 'md-ticket' }, async $ => {
    const b = await read($, band)
    if (isQuiet(b)) return {}
    await update($, isHidden, () => false)
    if (!b) return { text: 'MasterDeck has no ticket, PR or linked session for this session.' }
    await $.ui.open({ id: PANE, title: 'MasterDeck' })
    return { text: 'Opened the ticket pane.' }
  })

  on('command.run', { command: 'md-note' }, async ($, e) => (isQuiet(await read($, band)) ? {} : { text: await addNote($, e.args) }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = await read($, band)
    if (!b || isQuiet(b) || e.props.hasSurvey || (await read($, isHidden))) return next(e)
    const l = await read($, link)
    const now = await $.clock.now()
    const cols = e.props.bodyColumns ?? NARROW_COLS
    const { Box, Text, Button } = $.ui.resolve(e)
    const parts = segments(b, cols, l.isOffline ? now - l.lastAliveAt : null)
    const isNarrow = cols < NARROW_COLS
    // One line: the links live in the pane (a terminal without hyperlinks prints the whole URL).
    const ours = (
      <Box key="md-band" flexDirection="row" flexWrap="wrap" gap={1}>
        {parts.map(s => (
          <Text color={s.color} bold={s.bold} dimColor={s.dim}>{s.text}</Text>
        ))}
        <Button key="md-details" label={isNarrow ? 'More' : 'Details'} onPress={() => $.ui.open({ id: PANE, title: 'MasterDeck' })} />
        {!isNarrow && <Button key="md-hide" label="Hide" onPress={() => update($, isHidden, () => true)} />}
      </Box>
    )
    // Keep what other mods put here: ours first, theirs under it.
    const below = await next(e)
    return below ? <Box flexDirection="column">{ours}{below}</Box> : ours
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link } = $.ui.resolve(e)
    const b = await read($, band)
    if (!b) return <Text dimColor>MasterDeck has nothing for this session.</Text>
    if (isQuiet(b)) return <Box />
    const l = await read($, link)
    const pr = b.pr
    return (
      <Box flexDirection="column" gap={1}>
        {l.isOffline && <Text dimColor>MasterDeck is closed: this is what it last wrote.</Text>}
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
        <Text dimColor>/md-note &lt;text&gt; adds to this ticket's note.</Text>
      </Box>
    )
  })
}
