import type { AttentionAction, AttentionItem } from '@shared/dashboard'

/**
 * Inbox actions the row's button can run as they are: no text, choice or confirmation needed, and
 * nothing the renderer must open first. Every other kind is answered in the real Needs-you card
 * under the row (Reply…), so it acts exactly as in the Needs-you list.
 */
export const DIRECT: ReadonlySet<string> = new Set(['continue', 'compact', 'reload', 'loop-more', 'loop-continue', 'approve', 'send'])

/**
 * A row's buttons. `direct`: the actions its own buttons run; `answerHere`: Reply… is the way to
 * answer it (made primary when no direct action is). An inbox item that also offers `trust` (a
 * start held because Claude Code was not allowed in the folder) never runs `approve` (Try again)
 * from the row: the Needs-you card checks the folder's trust first, so it is left to Reply….
 * `trusting`: the inbox ids whose item has a `trust` action (the row carries only its main action).
 */
export function rowActions(item: AttentionItem, trusting: ReadonlySet<string>): { direct: AttentionAction[]; answerHere: boolean } {
  const held = !!item.inboxId && trusting.has(item.inboxId)
  const runs = (a: AttentionAction) => a.type !== 'inbox' || (DIRECT.has(a.action) && !(held && a.action === 'approve'))
  const direct = item.actions.filter(runs)
  const answerHere = !!item.inboxId && (held || item.actions.some((a) => !runs(a)))
  return { direct, answerHere }
}
