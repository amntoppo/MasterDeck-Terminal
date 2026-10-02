export type Repo = { name: string; path: string }

/** Repos whose name or path contains `q` (case-insensitive); blank `q` keeps all. */
export function filterRepos(repos: Repo[], q: string): Repo[] {
  const s = q.trim().toLowerCase()
  return s ? repos.filter((r) => r.name.toLowerCase().includes(s) || r.path.toLowerCase().includes(s)) : repos
}
