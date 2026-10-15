import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { refuses, seenWith, toReload } from './core'
import { deckFolder, deckRead, type DeckRead } from './deck'
import { requestText, toClaim } from './deliver'

/*
 * MasterDeck's core mod: nothing on screen. It
 * - judges every mod module that loads after it (`prependPlugins: ["masterdeck@masterdeck"]` puts
 *   it first) and refuses the ones switched off for this session in Tools → Mods
 *   (`offMods` in `deck/band/<sessionId>.json`); MasterDeck's own mods switch themselves;
 * - asks for a /reload-plugins when a refused mod is switched on again (a running mod switched off
 *   stays until the session starts again: a reload does not judge an unchanged module again);
 * - writes `deck/mods/<sessionId>.json` every 15 s: its heartbeat and the mods it saw, which the app
 *   lists in the Mods tab; `deliver: 1` says it takes MasterDeck's messages;
 * - submits MasterDeck's messages as prompts of their own (`deck/deliver/<sessionId>/`, see
 *   ./deliver), so MasterDeck never types into the prompt box over what the person is typing.
 * The features are mods of their own: masterdeck-ticket, masterdeck-alerts, masterdeck-note,
 * masterdeck-loop, masterdeck-board.
 */

// Keep in step with .claude-plugin/plugin.json.
const VERSION = '0.6.0'
const BEAT_MS = 15_000
const READ_MS = 2_000

// In $.state, so a reload of this module keeps what it saw (unchanged modules are not judged again).
const seen = atom({ plugin: 'masterdeck', key: 'seen' } as const, [])

let deck = ''
let sid = ''
/** Mods this load already asked a reload for (see toReload). */
const asked = new Set<string>()
let isReloading = false
let isDelivering = false
// How long to wait for MasterDeck's go after a claim (it answers within a few hundred ms).
const GO_MS = 3_000

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

async function offModsNow($: EngineInterface): Promise<string[]> {
  return (await readDeck($)).band?.offMods ?? []
}

/** A refused mod switched on again joins only at a reload: ask for one (queued until idle). */
async function reloadIfOn($: EngineInterface): Promise<void> {
  const offMods = await offModsNow($)
  for (const name of [...asked]) if (offMods.includes(name)) asked.delete(name)
  const again = toReload(await read($, seen), offMods, asked)
  if (!again.length || isReloading) return
  for (const name of again) asked.add(name)
  isReloading = true
  void $.command.run({ command: 'reload-plugins' }).catch(() => {}).finally(() => { isReloading = false })
}

const sleep = ($: EngineInterface, ms: number) => new Promise<void>(resolve => { $.clock.after(ms, () => resolve()) })

/** Claim MasterDeck's messages for this session; submit each one it says go to, once. */
async function deliver($: EngineInterface): Promise<void> {
  const dir = `${deck}/deliver/${sid}`
  if (!sid || isDelivering || !(await $.fs.exists(dir))) return
  isDelivering = true
  try {
    for (const id of toClaim((await $.fs.list(dir)).map(e => e.name))) {
      const text = requestText(await $.fs.read(`${dir}/${id}.json`))
      if (text === null) continue
      await $.fs.write(`${dir}/${id}.claim`, '')
      let isGo = false
      for (let waited = 0; waited < GO_MS && !isGo; waited += 200) {
        await sleep($, 200)
        isGo = await $.fs.exists(`${dir}/${id}.go`)
      }
      // No go: MasterDeck took it back (it types it, or holds it), or it stalled: say so, so a late go
      // is not counted as delivered. This load never submits this id.
      if (!isGo) {
        await $.fs.write(`${dir}/${id}.skip`, '')
        continue
      }
      try {
        await $.prompt.submit({ text, asUser: true })
        await $.fs.write(`${dir}/${id}.done`, JSON.stringify({ ok: true }))
      } catch (err) {
        await $.fs.write(`${dir}/${id}.done`, JSON.stringify({ ok: false, error: String(err).slice(0, 300) }))
      }
    }
  } finally {
    isDelivering = false
  }
}

/** Tell the app this session runs the core, and which mods it saw; only where MasterDeck is installed. */
async function beat($: EngineInterface, isEnded = false): Promise<void> {
  if (!sid || !(await $.fs.exists(`${deck}/alive`))) return
  const claude = (await $.session.version()).version
  const mods = await read($, seen)
  await $.fs.write(`${deck}/mods/${sid}.json`, JSON.stringify({ v: 1, version: VERSION, claude, at: await $.clock.now(), mods, deliver: 1, ...(isEnded ? { ended: true } : {}) }))
}

export const register: Register = on => {
  // Judge each mod that loads after this one. A failed judge lets the mod in.
  on('plugin.register', async ($, e, next) => {
    const isRefused = refuses(e, await offModsNow($))
    await update($, seen, list => seenWith(list, { name: e.name, provenance: e.provenance, version: e.version ?? null, tier: e.tier, loaded: !isRefused }))
    return isRefused ? { refuse: 'switched off for this session in MasterDeck' } : next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    deck = deckFolder(await $.env.get('MASTERDECK_HOME'), await $.env.get('HOME'))
    sid = await $.session.id()
    await beat($)
    $.clock.every(READ_MS, () => {
      void (async () => {
        sid = await $.session.id()
        await reloadIfOn($)
        await deliver($)
      })().catch(() => {})
    })
    $.clock.every(BEAT_MS, () => beat($).catch(() => {}))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await beat($, true).catch(() => {})
    return next(e)
  })
}
