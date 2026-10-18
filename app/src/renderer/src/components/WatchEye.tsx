import { useState } from 'react'
import { watchTip, type PrWatchRow } from '@shared/watchPr'
import { deck } from '../deck'
import { webConfirm } from '../webConfirm'

/** The PR tab a watch is asked for (#182): its id and name, its account (two or more), its Repo filter. */
export interface WatchTabRef {
  tabId: string
  tabName: string
  account?: string
  repo?: string
}

/** Watch or stop watching a PR; a session's own watch asks first (the Mac's window asks in main). Null: done. */
export async function setWatch(pr: string, on: boolean, tab: WatchTabRef, row?: PrWatchRow): Promise<string | null> {
  if (!on && row && !row.manual && !(await webConfirm(`Stop watching ${row.repo}#${row.number}? Its session won't hear about new comments on it.`, { confirmLabel: 'Stop watching', danger: true })))
    return null
  const r = await deck().prWatchSet({ pr, on, tabId: tab.tabId, tabName: tab.tabName, ...(tab.account ? { account: tab.account } : {}), ...(tab.repo ? { repo: tab.repo } : {}) })
  return r.ok || r.message === 'cancelled' ? null : r.message
}

const EyeIcon = ({ on }: { on: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M1 8s2.6-5 7-5 7 5 7 5-2.6 5-7 5-7-5-7-5Z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    <circle cx="8" cy="8" r="2.2" fill={on ? 'var(--bg)' : 'none'} stroke={on ? 'var(--bg)' : 'currentColor'} strokeWidth="1.4" />
  </svg>
)

/** The eye on a PR (#182): filled when MasterDeck watches it, dimmed when not; a click starts or stops the watch. */
export function WatchEye({ url, row, tab, onError }: { url: string; row: PrWatchRow | undefined; tab: WatchTabRef; onError?: (msg: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  const on = !!row
  return (
    <button
      className={`link-btn watch-eye${on ? ' on' : ''}`}
      disabled={busy}
      aria-pressed={on}
      aria-label={on ? 'Stop watching this PR' : 'Watch this PR'}
      title={watchTip(row, tab.tabId)}
      onClick={async (e) => {
        e.stopPropagation()
        setBusy(true)
        const msg = await setWatch(url, !on, tab, row).catch((err: unknown) => String(err))
        setBusy(false)
        onError?.(msg)
      }}
    >
      <EyeIcon on={on} />
    </button>
  )
}
