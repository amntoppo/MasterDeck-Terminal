import { isWeb as defaultIsWeb } from './web'

export type ConfirmRequest = {
  id: number
  message: string
  confirmLabel: string
  danger: boolean
  resolve(v: boolean): void
}
type Listener = (r: ConfirmRequest | null) => void

let isWeb = defaultIsWeb
/** For tests. */
export const setIsWeb = (fn: () => boolean): void => {
  isWeb = fn
}

let nextId = 1
const queue: ConfirmRequest[] = []
const listeners = new Set<Listener>()
const emit = () => listeners.forEach((l) => l(queue[0] ?? null))

/**
 * Ask before a destructive or installing action. On the web: an in-app modal (one at a time, in order). On the
 * desktop it resolves true at once — the native dialog in main (where there is one) still confirms.
 */
export function webConfirm(message: string, opts: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  if (!isWeb()) return Promise.resolve(true)
  return new Promise((done) => {
    const req: ConfirmRequest = {
      id: nextId++,
      message,
      confirmLabel: opts.confirmLabel ?? 'OK',
      danger: !!opts.danger,
      resolve(v) {
        const i = queue.indexOf(req)
        if (i < 0) return
        queue.splice(i, 1)
        done(v)
        emit()
      },
    }
    queue.push(req)
    if (queue.length === 1) emit()
  })
}

/** The modal subscribes: gets the current request (or null when none is pending). */
export function onConfirmRequest(cb: Listener): () => void {
  listeners.add(cb)
  if (queue[0]) cb(queue[0])
  return () => listeners.delete(cb)
}

/** A confirm is waiting: App's global shortcuts stay off until it is answered. */
export const confirmPending = (): boolean => queue.length > 0
