import type { AppState } from '@shared/types'

/** The Dashboard (#183): one screen over everything. A placeholder until the cards land. */
export function DashboardView(_props: { state: AppState }) {
  return (
    <section className="board-view panel dash-view">
      <header className="board-head">
        <h2>Dashboard</h2>
      </header>
    </section>
  )
}
