import { describe, expect, it } from 'vitest'
import { badgeLabel, retryAction, updateBusy } from './updates'

describe('retryAction', () => {
  it('checks again after a failed check or while offline', () => {
    expect(retryAction('check')).toBe('check')
    expect(retryAction('offline')).toBe('check')
    expect(retryAction(undefined)).toBe('check')
  })
  it('downloads again after a failed download or verification', () => {
    expect(retryAction('download')).toBe('download')
    expect(retryAction('verify')).toBe('download')
  })
  it('installs again after a failed install or a cancelled password prompt', () => {
    expect(retryAction('install')).toBe('restart')
    expect(retryAction('permission')).toBe('restart')
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
