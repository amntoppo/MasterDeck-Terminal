import { describe, expect, it } from 'vitest'
import { laneOf, taskStep } from './tasks'

const stage = (kind: 'merged' | 'rework' | 'approved' | 'changes' | 'ci-failing' | 'ready' | 'in-review') => ({ kind, prs: [12], why: '' })

describe('taskStep', () => {
  it('is on Coding until there is a PR', () => {
    expect(taskStep('working', null)).toEqual({ at: 1, tone: 'busy', note: 'coding' })
    expect(taskStep('idle', null)).toEqual({ at: 1, tone: 'wait', note: 'no PR yet' })
    expect(taskStep('needs-input', undefined).tone).toBe('bad')
  })
  it('follows the PR: open, review, merged', () => {
    expect(taskStep('in-review', stage('in-review'))).toMatchObject({ at: 2, tone: 'info' })
    expect(taskStep('ci-failing', stage('ci-failing'))).toMatchObject({ at: 2, tone: 'bad' })
    expect(taskStep('ready', stage('ready'))).toMatchObject({ at: 3, tone: 'info' })
    expect(taskStep('changes', stage('changes'))).toMatchObject({ at: 3, tone: 'wait' })
    expect(taskStep('approved', stage('approved'))).toMatchObject({ at: 3, tone: 'ok' })
    expect(taskStep('merged', stage('merged'))).toMatchObject({ at: 4, tone: 'done' })
  })
  it('shows a session fixing its PR as busy, and one waiting on you as bad', () => {
    expect(taskStep('working', stage('ci-failing')).tone).toBe('busy')
    expect(taskStep('needs-input', stage('ready')).tone).toBe('bad')
  })
  it('goes back to Coding on rework', () => {
    expect(taskStep('rework', stage('rework'))).toMatchObject({ at: 1, tone: 'busy' })
  })
})

describe('laneOf', () => {
  it('groups by what the task needs', () => {
    expect(laneOf('question')).toBe('you')
    expect(laneOf('changes')).toBe('you')
    expect(laneOf('rework')).toBe('working')
    expect(laneOf('approved')).toBe('review')
    expect(laneOf('merged')).toBe('done')
    expect(laneOf('suspended')).toBe('parked')
    expect(laneOf('idle')).toBe('idle')
  })
})
