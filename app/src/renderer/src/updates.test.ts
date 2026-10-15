import { describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/updates'
import { badgeLabel, retryAction, updateBusy } from './updates'

describe('retryAction', () => {
  const offer = { version: '0.10.0' } as UpdateState['offer']
  const st = (errorKind: UpdateState['errorKind'], withOffer = true) => ({ errorKind, offer: withOffer ? offer : undefined }) as Pick<UpdateState, 'errorKind' | 'offer'>
  it('checks again after a failed check or while offline', () => {
    expect(retryAction(st('check'))).toBe('check')
    expect(retryAction(st('offline'))).toBe('check')
    expect(retryAction(st(undefined))).toBe('check')
  })
  it('downloads again after a failed download or verification', () => {
    expect(retryAction(st('download'))).toBe('download')
    expect(retryAction(st('verify'))).toBe('download')
  })
  it('installs again after a failed install or a cancelled password prompt', () => {
    expect(retryAction(st('install'))).toBe('restart')
    expect(retryAction(st('permission'))).toBe('restart')
  })
  it('checks again when there is no offer (the helper failed and this is a new launch)', () => {
    for (const k of ['install', 'permission', 'download', 'verify'] as const) expect(retryAction(st(k, false))).toBe('check')
  })
})

describe('updateBusy', () => {
  it('is true only while something runs', () => {
    expect(['checking', 'downloading', 'verifying', 'installing'].every((p) => updateBusy(p as never))).toBe(true)
    expect(['idle', 'up-to-date', 'available', 'ready', 'error'].some((p) => updateBusy(p as never))).toBe(false)
  })
})

describe('badgeLabel', () => {
  it('names each badge', () => {
    expect(badgeLabel('required')).toBe('Required update')
    expect(badgeLabel('ready')).toBe('Update ready')
    expect(badgeLabel('available')).toBe('Update available')
  })
})
