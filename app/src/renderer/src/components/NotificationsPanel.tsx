import { useState } from 'react'
import { CHANNELS, NOTIFY_TYPES, cellOf, withCell } from '@shared/notifications'
import type { Settings } from '@shared/settings'
import { deck } from '../deck'
import { Field } from './AccountPanel'

/** Settings → Notifications (#135): Pause all, each type × channel, and a test. Drawn from the registry. */
export function NotificationsPanel({ settings: s, save }: { settings: Settings; save: (next: Settings) => Promise<void> }) {
  const [test, setTest] = useState<string | null>(null)
  return (
    <>
      <Field label="Pause all notifications" hint="No system notification until you turn this off. Needs you still lists everything, and your choices below are kept.">
        <button
          className={`switch ${s.notifyPaused ? 'on' : ''}`}
          role="switch"
          aria-checked={s.notifyPaused}
          aria-label="Pause all notifications"
          onClick={() => void save({ ...s, notifyPaused: !s.notifyPaused })}
        />
      </Field>
      <div className="notify-wrap">
        <table className={`notify-table${s.notifyPaused ? ' paused' : ''}`}>
          <thead>
            <tr>
              <th scope="col">Notification</th>
              {CHANNELS.map((c) => (
                <th key={c.id} scope="col" className={c.available ? '' : 'off'} title={c.note}>
                  {c.label}
                  {c.note && <span className="notify-note">{c.note}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {NOTIFY_TYPES.map((t) => (
              <tr key={t.id}>
                <th scope="row">
                  <div className="set-label">{t.label}</div>
                  <div className="set-hint">{t.hint}</div>
                </th>
                {CHANNELS.map((c) => {
                  const cell = cellOf(s, t.id, c.id)
                  return (
                    <td key={c.id} title={cell.why ?? undefined}>
                      <input
                        type="checkbox"
                        aria-label={`${t.label}: ${c.label}`}
                        checked={cell.checked}
                        disabled={cell.disabled}
                        onChange={(e) => void save({ ...s, notifications: withCell(s.notifications, t.id, c.id, e.target.checked) })}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Field label="Send test notification" hint="One through every channel that works now, whatever is picked or paused above.">
        <div className="f-row">
          <button
            className="btn"
            onClick={async () => {
              const r = await deck().notifyTest()
              setTest(r.message)
            }}
          >
            Send test
          </button>
          {test && (
            <span className="muted" role="status">
              {test}
            </span>
          )}
        </div>
      </Field>
    </>
  )
}
