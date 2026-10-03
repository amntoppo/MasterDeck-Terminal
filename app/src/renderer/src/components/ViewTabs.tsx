import { useState } from 'react'

export interface ViewTab {
  id: string
  name: string
  /** The account it shows (two or more GitHub accounts). */
  badge?: string
}

/**
 * Tabs over one view (Board, PRs): each a name and its own filters, kept by the caller. + adds one,
 * double-click renames, × closes (never the last).
 */
export function ViewTabs({
  tabs,
  activeId,
  onSelect,
  onAdd,
  onClose,
  onRename,
  addTitle,
}: {
  tabs: ViewTab[]
  activeId: string
  onSelect: (id: string) => void
  /** Returns the new tab's id, which opens for renaming. */
  onAdd: () => string
  onClose: (id: string) => void
  onRename: (id: string, name: string) => void
  addTitle: string
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <div className="board-tabs" role="tablist">
      {tabs.map((t) => (
        <div key={t.id} className={`board-tab ${t.id === activeId ? 'on' : ''}`} role="tab" aria-selected={t.id === activeId}>
          {renaming === t.id ? (
            <input
              className="board-tab-name"
              autoFocus
              defaultValue={t.name}
              onBlur={(e) => {
                if (e.target.value.trim()) onRename(t.id, e.target.value.trim())
                setRenaming(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button onClick={() => onSelect(t.id)} onDoubleClick={() => setRenaming(t.id)} title="Double-click to rename">
              {t.name}
              {t.badge && <span className="acct-badge">@{t.badge}</span>}
            </button>
          )}
          {tabs.length > 1 && (
            <button className="board-tab-x" title="Close this tab" aria-label={`Close ${t.name}`} onClick={() => onClose(t.id)}>
              ×
            </button>
          )}
        </div>
      ))}
      <button className="board-tab-add" onClick={() => setRenaming(onAdd())} title={addTitle}>
        +
      </button>
    </div>
  )
}

/** The name for a new tab: "<base> 2", "<base> 3", … whichever is free. */
export function nextTabName(tabs: ViewTab[], base: string): string {
  let n = tabs.length + 1
  while (tabs.some((t) => t.name === `${base} ${n}`)) n++
  return `${base} ${n}`
}
