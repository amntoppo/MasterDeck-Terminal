import { expect, test } from 'claude-code/testing'

import { noteAnswerText, noteRequestId } from './note'

test('makes request ids the app takes, and reads its answers', async () => {
  expect(/^[0-9]+-[0-9]+-[0-9]+$/.test(noteRequestId(1_791_578_586_510, 0.5))).toBe(true)
  expect(noteAnswerText(JSON.stringify({ ok: true, message: 'Added to the note of acme/tracker#86.' }))).toBe('Added to the note of acme/tracker#86.')
  expect(noteAnswerText(JSON.stringify({ ok: false, error: 'The text is too long for a note.' }))).toBe('Not saved: The text is too long for a note.')
  expect(noteAnswerText('?')).toBe('MasterDeck answered something this mod cannot read; look in Notes.')
})
