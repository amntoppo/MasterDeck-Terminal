/**
 * Run `run` with a busy flag up, and take the flag down whatever happens: a rejected call (the
 * window's bridge gone, an IPC error) must not leave a button on "Refreshing…" or a tab on
 * "Loading…" for good. The failure is not passed on: the caller's own state says what went wrong.
 */
export async function whileBusy(set: (busy: boolean) => void, run: () => Promise<unknown>): Promise<void> {
  set(true)
  try {
    await run()
  } catch {
    /* shown by the caller's state (the board's error line) */
  } finally {
    set(false)
  }
}
