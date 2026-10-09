import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Loop } from '../types'
import { deckFolder, deckRead, isOff, type DeckRead } from './deck'
import { USAGE, firstPrompt, isActive, newLoop, nextPrompt, parseLoopArgs, progressText, tailOf } from './loop'

/*
 * An agent loop in the session (issue #82): /md-loop [--max N] <check> -- <goal>. Claude works on
 * the goal; when that turn ends the check runs in the session's folder; while it fails, Claude gets
 * its last lines and another round, up to N. It ends when the check passes, after N rounds, when
 * the person interrupts a round's turn, presses Stop or types /md-loop stop, or when this mod is
 * switched off for the session in MasterDeck (Session details → Mods). Its progress is a line above
 * the prompt. The loop lives in $.state, so a reload of the module keeps it.
 * Only the turn a round started counts: it binds to the first main-loop turn that starts after the
 * round was submitted (`turnId`), so a subagent's turn or an earlier one never ends a round.
 */

const NAME = 'masterdeck-loop'
const READ_MS = 2_000
// The longest a check may run (the mods API's own ceiling).
const CHECK_MS = 600_000

const loop = atom({ plugin: 'masterdeck-loop', key: 'loop' } as const, null)

let deck = ''
let isQuiet = false

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

/** Switched off here: stop a loop that runs, and draw nothing. */
async function watchSwitch($: EngineInterface): Promise<void> {
  const off = isOff((await readDeck($)).band, NAME)
  if (off !== isQuiet) {
    isQuiet = off
    $.ui.invalidate('ui.render')
  }
  if (off && isActive(await read($, loop))) await stop($, 'switched off in MasterDeck')
}

async function stop($: EngineInterface, note: string): Promise<void> {
  await update($, loop, (l): Loop | null => (l && isActive(l) ? { ...l, status: 'stopped', note } : l))
}

/** Submit a round once the session is idle (never from inside a dispatch: a timer runs it). */
function submit($: EngineInterface, text: string): void {
  $.clock.after(0, () => {
    void $.prompt.submit({ text, asUser: true }).catch(() => stop($, 'the round could not be sent'))
  })
}

/** The round's turn ended: run the check, then pass, give up, or send the next round. */
async function runCheck($: EngineInterface): Promise<void> {
  const l = await read($, loop)
  if (!l || l.status !== 'checking') return
  let last: Loop['last']
  try {
    const r = await $.process.run(['sh', '-c', l.check], { timeoutMs: CHECK_MS })
    last = { exit: r.exitCode, tail: tailOf(r.stdout, r.stderr) }
  } catch (err) {
    last = { exit: 1, tail: `The check did not finish: ${String(err).slice(0, 300)}` }
  }
  // Stopped while the check ran: keep it stopped.
  const now = await read($, loop)
  if (!now || now.status !== 'checking') return
  if (last.exit === 0) {
    await update($, loop, (): Loop => ({ ...now, status: 'passed', last }))
    $.ui.toast(`Loop done in ${now.round} round${now.round === 1 ? '' : 's'}: ${now.check} passes`)
    return
  }
  if (now.round >= now.max) {
    await update($, loop, (): Loop => ({ ...now, status: 'gave-up', last }))
    $.ui.toast(`Loop stopped after ${now.max} rounds: ${now.check} still fails`)
    return
  }
  const next: Loop = { ...now, round: now.round + 1, status: 'running', turnId: null, last }
  await update($, loop, () => next)
  submit($, nextPrompt(next))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    deck = deckFolder(await $.env.get('MASTERDECK_HOME'), await $.env.get('HOME'))
    await $.command.register({ name: 'md-loop', description: 'Work in rounds until a check passes: /md-loop [--max N] <check> -- <goal>', argumentHint: '[--max N] <check> -- <goal> | stop' })
    await watchSwitch($)
    $.clock.every(READ_MS, () => watchSwitch($).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'md-loop' }, async ($, e) => {
    if (isQuiet) return {}
    const a = parseLoopArgs(e.args)
    const l = await read($, loop)
    if (a.kind === 'error') return { text: a.message }
    if (a.kind === 'status') return { text: l ? progressText(l) : USAGE }
    if (a.kind === 'stop') {
      if (!isActive(l)) return { text: 'No loop is running here.' }
      await stop($, 'stopped with /md-loop stop')
      return { text: 'Loop stopped.' }
    }
    if (isActive(l)) return { text: 'A loop already runs here: /md-loop stop ends it.' }
    const fresh = newLoop(a.check, a.goal, a.max)
    await update($, loop, () => fresh)
    submit($, firstPrompt(fresh))
    return { text: `Loop started: up to ${a.max} round${a.max === 1 ? '' : 's'} until \`${a.check}\` passes.` }
  })

  // The first main-loop turn after a round was submitted is that round's.
  on('turn.start', async ($, e, next) => {
    const l = await read($, loop)
    if (l?.status === 'running' && !l.turnId) await update($, loop, (): Loop => ({ ...l, turnId: e.turnId }))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const l = await read($, loop)
    if (l?.status === 'running' && !e.agentId && l.turnId === e.turnId) {
      if (e.reason === 'aborted') await stop($, 'you interrupted the turn')
      else if (e.reason !== 'answer') await stop($, e.reason === 'refusal' ? 'the model refused' : 'the turn ended on an error')
      else {
        await update($, loop, (): Loop => ({ ...l, status: 'checking' }))
        // The check can take minutes: run it outside this dispatch.
        $.clock.after(0, () => { void runCheck($).catch(() => stop($, 'the check could not run')) })
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, loop)
    if (!l || isQuiet || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const color = l.status === 'passed' ? 'green' : l.status === 'gave-up' ? 'red' : l.status === 'stopped' ? undefined : 'cyan'
    const ours = (
      <Box key="md-loop" flexDirection="row" flexWrap="wrap" gap={1}>
        <Text color={color} dimColor={l.status === 'stopped'}>{progressText(l)}</Text>
        {isActive(l) ? (
          <Button key="md-loop-stop" label="Stop" onPress={() => stop($, 'stopped from the loop line')} />
        ) : (
          <Button key="md-loop-dismiss" label="Dismiss" onPress={() => update($, loop, () => null)} />
        )}
      </Box>
    )
    const below = await next(e)
    return below ? <Box flexDirection="column">{ours}{below}</Box> : ours
  })
}
