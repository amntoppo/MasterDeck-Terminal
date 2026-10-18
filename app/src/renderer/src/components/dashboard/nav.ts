import type { ActivityTarget } from '@shared/activityLog'
import type { AttentionTarget } from '@shared/dashboard'
import type { Ticket } from '@shared/ticket'

/**
 * Where a Dashboard row leads (#183), through what App already has. One stable object for the
 * view's life, so the memo()'d cards do not draw again because App made new callbacks.
 */
export interface DashNav {
  /** A listed session's terminal; a session no longer listed opens Terminals. */
  session(key: string): void
  /** The PR popup (the web app: the PR on GitHub). */
  pr(url: string, title?: string): void
  /** The ticket's session, or the Start dialog. */
  ticket(t: Ticket): void
  view(v: string): void
  settings(section: string): void
  /** Terminals, scrolled to the Needs-you list. */
  needsYou(): void
  /** Pull requests on the tab named for a preset (Mine, Needs my review, Recently merged), when there is one. */
  prsTab(tab: 'mine' | 'review' | 'merged'): void
  note(id: string): void
  meeting(id: string): void
}

/** Opens a Needs-attention or Timeline row's target. */
export function go(nav: DashNav, t: AttentionTarget | ActivityTarget): void {
  if ('session' in t) nav.session(t.session)
  else if ('pr' in t) nav.pr(t.pr)
  else if ('ticket' in t) nav.ticket(t.ticket)
  else if ('schedules' in t) nav.view('schedules')
  else if ('note' in t) nav.note(t.note)
  else if ('meeting' in t) nav.meeting(t.meeting)
  else if ('view' in t) nav.view(t.view)
  else if ('settings' in t) nav.settings(t.settings)
}
