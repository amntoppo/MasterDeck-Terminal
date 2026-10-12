import type { MouseEvent } from 'react'
import { tabId, type SessionTab } from '@shared/sessionTabs'
import type { Session } from '@shared/types'
import { sessionTabs, useSessionTabs } from '../sessionTabsStore'
import { FileTab } from './FileTab'

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1)

function label(t: SessionTab): { text: string; title: string; icon: string } {
  if (t.kind === 'terminal') return { text: 'Terminal', title: 'The session’s terminal', icon: '›_' }
  if (t.kind === 'file') return { text: base(t.path), title: t.path, icon: '▤' }
  return { text: base(t.path), title: `Changes in ${t.path} (${t.base === 'branch' ? 'whole branch' : 'uncommitted'})`, icon: '±' }
}

/**
 * A session's row of tabs: the terminal first (never closed or moved), then its file and diff
 * tabs. × or a middle-click closes one.
 */
export function SessionTabRow({ sessionKey }: { sessionKey: string }) {
  const { tabs, active } = useSessionTabs(sessionKey)
  const close = (id: string) => sessionTabs.close(sessionKey, id)
  return (
    <div className="stabs" role="tablist" aria-label="Session tabs">
      {tabs.map((t) => {
        const id = tabId(t)
        const l = label(t)
        const closable = t.kind !== 'terminal'
        return (
          <div
            key={id}
            role="tab"
            aria-selected={id === active}
            className={`stab ${t.kind}${id === active ? ' on' : ''}`}
            title={l.title}
            onClick={() => sessionTabs.activate(sessionKey, id)}
            // A middle-click closes, as in a browser; its mousedown would start autoscroll.
            onMouseDown={(e: MouseEvent) => e.button === 1 && e.preventDefault()}
            onAuxClick={(e: MouseEvent) => {
              if (e.button === 1 && closable) {
                e.preventDefault()
                close(id)
              }
            }}
          >
            <span className="stab-icon" aria-hidden>
              {l.icon}
            </span>
            <span className="stab-name">{l.text}</span>
            {closable && (
              <button
                className="stab-x"
                aria-label={`Close ${l.text}`}
                title="Close (middle-click)"
                onClick={(e) => {
                  e.stopPropagation()
                  close(id)
                }}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** What a file or diff tab shows. */
export function SessionTabBody({ session, tab, visible }: { session: Session; tab: Exclude<SessionTab, { kind: 'terminal' }>; visible: boolean }) {
  if (tab.kind === 'file') return <FileTab key={tab.path} session={session} path={tab.path} visible={visible} />
  return <div className="welcome">{tab.path}</div>
}
