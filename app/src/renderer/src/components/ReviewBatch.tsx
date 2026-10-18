import { useState } from 'react'
import { BATCH_STATUS_TEXT, batchLabel, type BatchItem, type BatchTabView } from '@shared/reviewBatch'
import { deck } from '../deck'

/** What a status shows beside its words. */
const MARK: Record<BatchItem['status'], string> = { queued: '○', reviewing: '●', posted: '✓', skipped: '–', failed: '✗', cancelled: '×' }

const detail = (i: BatchItem): string =>
  i.status === 'posted' ? `${i.comments} comment${i.comments === 1 ? '' : 's'}` : i.note && i.status !== 'cancelled' ? i.note : ''

/** A PR row's place in the tab's batch (Review selected, #176). */
export function BatchChip({ item }: { item: BatchItem }) {
  const d = detail(item)
  return (
    <span className={`chip batch-chip b-${item.status}`} title={`Review selected: ${BATCH_STATUS_TEXT[item.status]}${d ? ` · ${d}` : ''}`}>
      {MARK[item.status]} {BATCH_STATUS_TEXT[item.status]}
    </span>
  )
}

/**
 * The tab's batch in the Review with Claude panel: each PR's status (a posted one links to its
 * review), Retry for one that failed, was skipped or cancelled, Cancel batch while it runs, and the
 * summary once it ended.
 */
export function BatchPanel({ batch, onRetry, onCancel }: { batch: BatchTabView; onRetry: (url: string) => void; onCancel: () => void }) {
  const [open, setOpen] = useState(true)
  const done = batch.items.filter((i) => i.status !== 'queued' && i.status !== 'reviewing').length
  return (
    <div className="batch-panel" aria-label="Review selected">
      <div className="batch-head">
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? 'Fold' : 'Show each PR'}>
          {open ? '▾' : '▸'}
        </button>
        <b>Review selected</b>
        <span className={`small ${batch.running ? 'wait' : 'muted'}`}>{batch.summary ?? `${done} of ${batch.items.length} done`}</span>
        <span style={{ flex: 1 }} />
        {batch.running && (
          <button className="btn" onClick={onCancel} title="Stop every PR not posted yet: the session can no longer post to them">
            Cancel batch
          </button>
        )}
      </div>
      {open && (
        <ul className="batch-list">
          {batch.items.map((i) => {
            const d = detail(i)
            return (
              <li key={i.url}>
                <span className={`b-mark b-${i.status}`} aria-hidden>
                  {MARK[i.status]}
                </span>
                <button className="link-btn" onClick={() => deck().openExternal(i.reviewUrl ?? i.url)} title={i.reviewUrl ? 'Open the review on GitHub' : i.title}>
                  {batchLabel(i)}
                </button>
                <span className="batch-title muted" title={i.title}>
                  {i.title}
                </span>
                <span className={`small b-${i.status}`}>{BATCH_STATUS_TEXT[i.status]}</span>
                {d && (
                  <span className="small muted batch-note" title={d}>
                    {d}
                  </span>
                )}
                {(i.status === 'failed' || i.status === 'skipped' || i.status === 'cancelled') && (
                  <button className="link-btn" onClick={() => onRetry(i.url)} title="Review it again">
                    Retry
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
