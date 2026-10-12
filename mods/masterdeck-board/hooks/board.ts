/**
 * What MasterDeck writes for an account: `deck/boards/<key>.json`. The app's copy is
 * `app/src/shared/modBand.ts` (`ModBoard`); keep the two in step and bump `v`.
 */
export type Board = {
  v: 1
  account: string | null
  sprint: string | null
  derived: boolean
  columns: { name: string; count: number; cards: { label: string; title: string; url: string; assignees: string[] }[] }[]
}

/** The board file's text, when it is one this version reads. */
export function parseBoard(text: string): Board | null {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return null
  }
  if (!o || typeof o !== 'object') return null
  const b = o as Partial<Board>
  if (b.v !== 1 || !Array.isArray(b.columns)) return null
  return b as Board
}

/** The pane's first line: whose board, which sprint, and whether its columns are MasterDeck's. */
export function boardHeading(b: Board): string {
  return [
    b.account ? `${b.account}'s board` : 'Board',
    b.sprint ? `sprint ${b.sprint}` : null,
    b.derived ? 'no GitHub board: MasterDeck\'s columns from its repositories\' issues' : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** A column's heading, with how many cards it holds. */
export function columnHeading(c: Board['columns'][number]): string {
  return `${c.name} (${c.count})`
}

/** What a column holds beyond the cards listed. */
export function moreText(c: Board['columns'][number]): string | null {
  const more = c.count - c.cards.length
  return more > 0 ? `and ${more} more` : null
}
