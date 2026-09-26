/** Board and PRs before GitHub is set up: say what's missing, and open Setup. */
export function ConnectGithub({ title, what, onConnect }: { title: string; what: string; onConnect: () => void }) {
  return (
    <section className="board-view panel">
      <header className="board-head">
        <h2>{title}</h2>
      </header>
      <div className="connect-gh">
        <h3>Connect your GitHub</h3>
        <div className="muted">
          {what} come from GitHub. Pick your account, organization and the repository that holds your issues; sessions keep working
          either way.
        </div>
        <button className="btn primary" onClick={onConnect}>
          Connect your GitHub
        </button>
      </div>
    </section>
  )
}
