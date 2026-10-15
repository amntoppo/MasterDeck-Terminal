import { useEffect, useState } from 'react'
import type { UpdatePhase, UpdateState } from '@shared/updates'
import { deck } from './deck'
import { can } from './web'

/**
 * The update state (#122), followed live; null on the web (a browser never sees or drives the Mac's
 * updates: the calls are blocked there) and until the first answer.
 */
export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    if (!can('updateState') || !can('onUpdateChanged')) return
    let alive = true
    deck()
      .updateState()
      .then((s) => alive && s && setState((cur) => cur ?? s))
      .catch(() => {})
    const off = deck().onUpdateChanged((s) => setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

/**
 * What Try again does after an error: check again, download again, or install again. With no offer
 * (a launch after the helper failed: nothing is staged any more) only a new check can help.
 */
export function retryAction(s: Pick<UpdateState, 'errorKind' | 'offer'>): 'check' | 'download' | 'restart' {
  if (!s.offer) return 'check'
  switch (s.errorKind) {
    case 'download':
    case 'verify':
      return 'download'
    case 'install':
    case 'permission':
      return 'restart'
    default:
      return 'check'
  }
}

/** Phases in which Check for updates waits (something is already running). */
export function updateBusy(phase: UpdatePhase): boolean {
  return phase === 'checking' || phase === 'downloading' || phase === 'verifying' || phase === 'installing'
}

/** The rail's Settings label for a badge. */
export function badgeLabel(b: 'required' | 'ready' | 'available'): string {
  return b === 'required' ? 'Required update' : b === 'ready' ? 'Update ready' : 'Update available'
}
