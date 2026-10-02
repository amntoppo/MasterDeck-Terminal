import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { DECK_ACCESS } from './remoteDeck'
import { CH } from './ipc'

// Only DeckApi members: everything after "export interface DeckApi" up to the closing brace.
const api = (() => {
  const src = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('export interface DeckApi'))
  return [...body.slice(0, body.indexOf('\n}')).matchAll(/^\s{2}(\w+)\??\s*[(:]/gm)].map((m) => m[1])
})()

describe('DECK_ACCESS', () => {
  it('classifies every DeckApi member', () => {
    for (const m of api) expect(DECK_ACCESS, `unclassified DeckApi member: ${m}`).toHaveProperty(m)
    expect(Object.keys(DECK_ACCESS).length).toBe(api.length)
  })
  it('remote entries name a real channel', () => {
    const chans = new Set(Object.values(CH))
    for (const [m, a] of Object.entries(DECK_ACCESS)) if (a.kind === 'remote' || a.kind === 'event') expect(chans, m).toContain(a.ch)
  })
  it('first-release allowlist is exactly the spec list', () => {
    const remote = Object.entries(DECK_ACCESS).filter(([, a]) => a.kind === 'remote' || a.kind === 'event').map(([m]) => m).sort()
    expect(remote).toEqual(['answerMenu','approve','defaultModel','dismissStopped','getState','inboxAct','linkSession','masterStart','onFocusSession','onPtyData','onPtyExit','onShowInboxItem','onShowNeedsYou','onState','ptyClose','ptyOpen','ptyResize','ptyWrite','queueEdit','queueList','queueSendNext','reject','resumeSession','resumeStopped','sendText','setManualStatus','setStatus','startClaude','stopOtherSession','stopSession','stopSessions','templates','workspaceRepos'].sort())
  })
})
