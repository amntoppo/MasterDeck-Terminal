import { deck } from './deck'
import { can, isWeb } from './web'

/** The Meetings page is the Mac's window only: macOS, never the web app. */
export const meetingsHere = (): boolean => !isWeb() && deck().platform === 'darwin' && can('meetingsList')

type Opener = (id: string, t: number | null) => void
let opener: Opener | null = null

/** The App sets this: open the Meetings page at a meeting (and a time in seconds). */
export function setMeetingOpener(fn: Opener | null): void {
  opener = fn
}

/** A `masterdeck://meetings/<id>?t=` link was clicked (MarkdownView), or a Needs-you Open. */
export function openMeetingAt(id: string, t: number | null): void {
  if (meetingsHere()) opener?.(id, t)
}
