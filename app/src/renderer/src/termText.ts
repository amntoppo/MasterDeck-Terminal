import type { IBuffer, IBufferRange } from '@xterm/xterm'

/** Rows of one wrapped line MasterDeck joins at most (a link longer than this is cut). */
const MAX_ROWS = 40

/** Where one UTF-16 unit of the text sits on screen: 1-based column and row, and its cell width. */
interface Cell {
  x: number
  y: number
  w: number
}

export interface LogicalLine {
  text: string
  /** One per UTF-16 unit of `text`. */
  cells: Cell[]
}

/**
 * The whole line row `y` (1-based) belongs to, its wrapped rows joined, with each character's cell,
 * so a match in the text maps back to the screen whatever the wide characters before it.
 */
export function logicalLine(buf: IBuffer, y: number): LogicalLine {
  let top = y - 1
  while (top > 0 && y - 1 - top < MAX_ROWS && buf.getLine(top)?.isWrapped) top--
  let text = ''
  const cells: Cell[] = []
  const cell = buf.getNullCell()
  for (let row = top; row < top + MAX_ROWS; row++) {
    const line = buf.getLine(row)
    if (!line || (row > top && !line.isWrapped)) break
    for (let x = 0; x < line.length; x++) {
      if (!line.getCell(x, cell)) break
      const w = cell.getWidth()
      if (w === 0) continue
      const chars = cell.getChars() || ' '
      text += chars
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: row + 1, w })
    }
  }
  return { text, cells }
}

/** The screen range of text offsets [start, end), for an xterm link. */
export function cellRange(line: LogicalLine, start: number, end: number): IBufferRange {
  const a = line.cells[start]
  const b = line.cells[end - 1]
  return { start: { x: a.x, y: a.y }, end: { x: b.x + b.w - 1, y: b.y } }
}
