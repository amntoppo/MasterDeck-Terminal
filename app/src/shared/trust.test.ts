import { describe, expect, it } from 'vitest'
import type { Proposal } from './types'
import { heldForTrust, retryRequest, startFlags, trustHeldAssign, isNotTrusted, needsTrust, remoteTrustMessage, startBlocked, trustLine, trustView, waitForTrust } from './trust'

// What `claude --bg` prints in a folder whose trust prompt was never accepted, as `master spawn` reports it.
const REFUSAL = 'Workspace not trusted. Run `claude` in <a checkout folder> once and accept the trust prompt, then retry.'

describe('isNotTrusted', () => {
  it("recognises Claude Code's refusal, with or without the proposal in front", () => {
    expect(isNotTrusted(REFUSAL)).toBe(true)
    expect(isNotTrusted(`proposal 85: ${REFUSAL}`)).toBe(true)
  })
  it('allows for small changes of wording', () => {
    for (const t of ['workspace is not trusted', 'Error: Workspace  not  trusted', "This workspace isn't trusted yet.", 'WORKSPACE NOT TRUSTED'])
      expect(isNotTrusted(t), t).toBe(true)
  })
  it('leaves every other failure alone', () => {
    for (const t of ['', null, undefined, 'cwd does not exist: api', 'claude: command not found', 'not logged in', 'trusted workspace', 'proposal 85 is sent, not approved'])
      expect(isNotTrusted(t), String(t)).toBe(false)
  })
})

describe('needsTrust', () => {
  it('a folder known not to be trusted needs it; a trusted one never does', () => {
    expect(needsTrust(false)).toBe(true)
    expect(needsTrust(true)).toBe(false)
    expect(needsTrust(true, 'not logged in')).toBe(false)
  })
  it('not known: only after a start that Claude Code refused for it', () => {
    expect(needsTrust(null)).toBe(false)
    expect(needsTrust(undefined)).toBe(false)
    expect(needsTrust(null, 'not logged in')).toBe(false)
    expect(needsTrust(null, REFUSAL)).toBe(true)
    expect(needsTrust(undefined, `proposal 85: ${REFUSAL}`)).toBe(true)
  })
})

describe('trustView', () => {
  const folder = 'code/api'
  it('says it plainly and offers to open Claude there', () => {
    expect(trustLine(folder)).toBe('Claude Code has not been allowed to work in code/api yet.')
    expect(trustView(folder, { trusted: false, opened: false, desktop: true })).toEqual({
      step: 'ask',
      line: 'Claude Code has not been allowed to work in code/api yet.',
      hint: 'Open Claude there once and accept its prompt.',
      open: true,
    })
  })
  it('while the tab is open it waits, and the button stays for a tab that was closed', () => {
    const v = trustView(folder, { trusted: false, opened: true, desktop: true })
    expect([v.step, v.open]).toEqual(['waiting', true])
    expect(v.hint).toBe('Accept the prompt in the tab that opened. This notices by itself.')
  })
  it('once trusted: start, and the tab can be closed', () => {
    expect(trustView(folder, { trusted: true, opened: true, desktop: true })).toEqual({
      step: 'ready',
      line: 'Claude Code can work in code/api now.',
      hint: 'You can close that tab.',
      open: false,
    })
    expect(trustView(folder, { trusted: true, opened: false, desktop: true }).hint).toBeNull()
  })
  it('in a browser or on a phone there is no tab to open: it is done on the Mac', () => {
    const v = trustView(folder, { trusted: false, opened: false, desktop: false })
    expect([v.step, v.open]).toEqual(['ask', false])
    expect(v.hint).toBe('Do this on your Mac: open Claude in that folder once and accept its prompt.')
  })
  it('without a folder there is nothing to open', () => {
    const v = trustView(null, { trusted: null, opened: false, desktop: true })
    expect(v.line).toBe('Claude Code has not been allowed to work in that folder yet.')
    expect(v.open).toBe(false)
    expect(v.hint).toBe('Run claude in that folder once and accept its prompt.')
  })
})

describe('startBlocked', () => {
  it('Start waits only for a folder known not to be trusted, in the window that can fix it', () => {
    expect(startBlocked(false, { desktop: true, anyway: false })).toBe(true)
    expect(startBlocked(false, { desktop: true, anyway: true })).toBe(false)
    expect(startBlocked(false, { desktop: false, anyway: false })).toBe(false)
    for (const t of [true, null, undefined]) expect(startBlocked(t, { desktop: true, anyway: false })).toBe(false)
  })
})

describe('heldForTrust', () => {
  const p = (over: Partial<Proposal>): Proposal => ({ id: 85, kind: 'ASSIGN', issue: 9, status: 'held', heldFor: 'trust', summary: 's', message: 'm', note: REFUSAL, target: { spawn: { name: '9-x', cwd: 'code/api', prompt: 'go' } }, ...over })
  it("a start `master spawn` held because Claude Code refused its folder: the proposal's own folder", () => {
    expect(heldForTrust(p({}))).toEqual({ folder: 'code/api' })
    expect(heldForTrust(p({ target: { spawn: { name: '9-x' } } }))).toEqual({ folder: null })
    expect(heldForTrust(p({ note: 'reworded by a later Claude Code' }))).toEqual({ folder: 'code/api' })
  })
  it('never by its note alone: master-agent can write any note', () => {
    expect(heldForTrust(p({ heldFor: undefined }))).toBeNull()
    expect(heldForTrust(p({ heldFor: 'other' }))).toBeNull()
  })
  it('nothing else', () => {
    expect(heldForTrust(p({ status: 'blocked' }))).toBeNull()
    expect(heldForTrust(p({ status: 'sent' }))).toBeNull()
    expect(heldForTrust(p({ target: { session: '9-x' } }))).toBeNull()
  })
})

describe('trustHeldAssign', () => {
  const p = (over: Partial<Proposal>): Proposal => ({ id: 85, kind: 'ASSIGN', issue: 9, status: 'held', heldFor: 'trust', summary: 's', message: 'm', note: REFUSAL, target: { spawn: { name: '9-x', cwd: 'code/api', prompt: 'go' } }, ...over })
  it("the ticket's refused start, the newest one", () => {
    expect(trustHeldAssign([p({ id: 80 }), p({ id: 85 }), p({ id: 90, issue: 10 })], { repo: null, number: 9 })?.id).toBe(85)
  })
  it('not another ticket, kind or reason', () => {
    expect(trustHeldAssign([p({ repo: 'acme/api' })], { repo: null, number: 9 })).toBeNull()
    expect(trustHeldAssign([p({ kind: 'PRREVIEW' })], { repo: null, number: 9 })).toBeNull()
    expect(trustHeldAssign([p({ heldFor: undefined })], { repo: null, number: 9 })).toBeNull()
    expect(trustHeldAssign([p({ status: 'sent' })], { repo: null, number: 9 })).toBeNull()
  })
})

describe('startFlags', () => {
  it("unchanged from master's proposal: approve it, or only spawn one already approved", () => {
    expect(startFlags({ proposalId: 20, edited: false, approvedId: undefined, heldId: undefined })).toEqual({ approved: false })
    expect(startFlags({ proposalId: 20, edited: false, approvedId: 20, heldId: undefined })).toEqual({ approved: true })
  })
  it('unchanged from the refused start of this ticket: that same proposal is tried again', () => {
    expect(startFlags({ proposalId: 85, edited: false, approvedId: undefined, heldId: 85 })).toEqual({ approved: true, retry: true })
  })
  it('edited, or no proposal: a new one, never a retry', () => {
    expect(startFlags({ proposalId: 85, edited: true, approvedId: undefined, heldId: 85 })).toEqual({ approved: false })
    expect(startFlags({ proposalId: null, edited: true, approvedId: 20, heldId: 85 })).toEqual({ approved: false })
  })
})

describe('retryRequest', () => {
  const req = { issue: 9, name: '9-x', cwd: 'code/api', prompt: 'P', proposalId: null, edited: true, approved: false, model: 'sonnet' }
  it('a start Claude Code refused for its folder: the held proposal itself, marked as a retry', () => {
    expect(retryRequest(req, 85, `proposal 85: ${REFUSAL}`)).toEqual({ ...req, proposalId: 85, edited: false, approved: true, retry: true })
  })
  it('any other failure: exactly what Retry always sent', () => {
    expect(retryRequest(req, 85, 'proposal 85: not logged in')).toEqual({ ...req, proposalId: 85, edited: false, approved: true })
    expect(retryRequest(req, 85, undefined)).toEqual({ ...req, proposalId: 85, edited: false, approved: true })
  })
  it('no proposal yet: start over', () => {
    expect(retryRequest(req, undefined, REFUSAL)).toBe(req)
  })
})

describe('remoteTrustMessage', () => {
  it('tells a phone or an API caller what to do on the Mac', () => {
    expect(remoteTrustMessage('code/api')).toBe(
      'Claude Code has not been allowed to work in code/api yet. Do this on your Mac: in MasterDeck, Needs you has this start with Open Claude there… and Try again.',
    )
  })
})

describe('waitForTrust', () => {
  const clock = () => {
    let t = 0
    return { now: () => t, pause: async (ms: number) => void (t += ms), add: (ms: number) => void (t += ms) }
  }
  it('asks again until the folder is trusted, then stops', async () => {
    const c = clock()
    const answers: (boolean | null)[] = [false, null, true, false]
    const asked: number[] = []
    const ok = await waitForTrust(async (s) => (asked.push(s), c.add(s * 1000), answers.shift() ?? false), { alive: () => true, ...c })
    expect(ok).toBe(true)
    expect(asked).toEqual([15, 15, 15])
  })
  it('stops when nobody waits any more (the dialog closed)', async () => {
    const c = clock()
    let n = 0
    expect(await waitForTrust(async (s) => (n++, c.add(s * 1000), false), { alive: () => n < 2, ...c })).toBe(false)
    expect(n).toBe(2)
  })
  it('gives up after ten minutes', async () => {
    const c = clock()
    let n = 0
    expect(await waitForTrust(async (s) => (n++, c.add(s * 1000), false), { alive: () => true, ...c })).toBe(false)
    expect(n).toBe(40)
  })
  it('an answer that comes at once (the CLI failed) does not make it spin', async () => {
    const c = clock()
    let n = 0
    expect(await waitForTrust(async () => (n++, null), { alive: () => true, ...c })).toBe(false)
    expect(n).toBe(300) // one look every two seconds, not thousands
  })
  it('a call that throws counts as not known', async () => {
    const c = clock()
    let n = 0
    const ok = await waitForTrust(async () => {
      if (n++ === 0) throw new Error('gone')
      return true
    }, { alive: () => true, ...c })
    expect([ok, n]).toEqual([true, 2])
  })
})
