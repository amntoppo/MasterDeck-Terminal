// The product images, all in one place. They are drawn placeholders (public/screens/*.svg) of the
// real screens. To use a real screenshot: put it in public/screens/ and change `src` (and `width`
// and `height`) here; every page reads them from this file.
export type Screen = { src: string; alt: string; width: number; height: number; title: string }

export const SCREENS = {
  sessions: {
    src: '/screens/sessions-list.svg',
    title: 'MasterDeck — Terminals',
    alt: 'MasterDeck’s Terminals view: the Sessions column grouped into Needs you, Working and In review, a Claude Code terminal in the middle, and the session’s details on the right.',
    width: 1440,
    height: 900,
  },
  board: {
    src: '/screens/board-tickets.svg',
    title: 'MasterDeck — Board',
    alt: 'MasterDeck’s Board: GitHub Project tickets in Todo, In Dev, PR Raised and Done columns, each card showing its session, PR and spend.',
    width: 1440,
    height: 900,
  },
  workflow: {
    src: '/screens/workflow-canvas.svg',
    title: 'MasterDeck — Workflow',
    alt: 'MasterDeck’s Workflow canvas: triggers, skills and built-ins joined by arrows, from a session starting to its PR merging.',
    width: 1440,
    height: 900,
  },
  costs: {
    src: '/screens/costs-dashboard.svg',
    title: 'MasterDeck — Costs',
    alt: 'MasterDeck’s Costs view: spend today, over 7 and 30 days, a 14-day bar chart, and spend per ticket and per session.',
    width: 1440,
    height: 900,
  },
} satisfies Record<string, Screen>
