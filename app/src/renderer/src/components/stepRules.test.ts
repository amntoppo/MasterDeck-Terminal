import { describe, expect, it } from 'vitest'
import { canAdvance, type StepCtx } from './stepRules'

const none: StepCtx = { signedIn: false, toolsDone: false, ghOk: false, hasPrimaryRepo: false, finding: false }

describe('canAdvance', () => {
  it('Account: Next needs sign-in', () => {
    expect(canAdvance(0, none)).toBe(false)
    expect(canAdvance(0, { ...none, signedIn: true })).toBe(true)
  })
  it('later steps keep their rules', () => {
    expect(canAdvance(1, none)).toBe(false)
    expect(canAdvance(1, { ...none, toolsDone: true })).toBe(true)
    expect(canAdvance(2, none)).toBe(false)
    expect(canAdvance(2, { ...none, ghOk: true })).toBe(true)
    expect(canAdvance(3, { ...none, hasPrimaryRepo: true, finding: true })).toBe(false)
    expect(canAdvance(3, { ...none, hasPrimaryRepo: true })).toBe(true)
    expect(canAdvance(4, none)).toBe(true)
  })
})
