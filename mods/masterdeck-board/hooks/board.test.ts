import { expect, test } from 'claude-code/testing'

import { boardHeading, columnHeading, moreText, parseBoard, type Board } from './board'

const BOARD: Board = {
  v: 1,
  account: 'alice',
  sprint: 'Sprint 7',
  derived: false,
  columns: [{ name: 'In Dev', count: 32, cards: [{ label: '#86', title: 'Mods', url: 'https://github.com/acme/tracker/issues/86', assignees: ['alice'] }] }],
}

test('reads only a board file of this version', async () => {
  expect(parseBoard(JSON.stringify(BOARD))).toEqual(BOARD)
  expect(parseBoard(JSON.stringify({ ...BOARD, v: 2 }))).toBe(null)
  expect(parseBoard('{')).toBe(null)
})

test('names the board, its columns, and what is not listed', async () => {
  expect(boardHeading(BOARD)).toBe("alice's board · sprint Sprint 7")
  expect(boardHeading({ ...BOARD, account: null, sprint: null, derived: true })).toBe("Board · no GitHub board: MasterDeck's columns from its repositories' issues")
  expect(columnHeading(BOARD.columns[0]!)).toBe('In Dev (32)')
  expect(moreText(BOARD.columns[0]!)).toBe('and 31 more')
  expect(moreText({ ...BOARD.columns[0]!, count: 1 })).toBe(null)
})
