/** The phone's quick-key bar above the terminal: keys a soft keyboard lacks, as the bytes xterm would send. */
export const QUICK_KEYS = ['Esc', 'Tab', '⇧Tab', '^C', '↑', '↓', '←', '→', 'Enter', 'y', 'n', '/'] as const
export type QuickKey = (typeof QUICK_KEYS)[number]

const ARROW: Partial<Record<QuickKey, string>> = { '↑': 'A', '↓': 'B', '→': 'C', '←': 'D' }

/** `appCursor`: the program turned on application cursor keys (DECCKM), so arrows go as ESC O x. */
export function quickKeyBytes(k: QuickKey, appCursor = false): string {
  const a = ARROW[k]
  if (a) return (appCursor ? '\x1bO' : '\x1b[') + a
  switch (k) {
    case 'Esc':
      return '\x1b'
    case 'Tab':
      return '\t'
    case '⇧Tab':
      return '\x1b[Z'
    case '^C':
      return '\x03'
    case 'Enter':
      return '\r'
    default:
      return k
  }
}
