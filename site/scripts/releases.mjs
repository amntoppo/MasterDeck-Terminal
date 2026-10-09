// Refresh src/data/releases.json from GitHub's releases (npm run releases; npm run deploy runs it).
// The file is committed, so a build without network still has a changelog. GITHUB_TOKEN, when set,
// lifts the 60-an-hour limit for unauthenticated reads.
import { writeFileSync } from 'node:fs'

const REPO = 'amntoppo/MasterDeck-Terminal'
const out = new URL('../src/data/releases.json', import.meta.url)
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'masterdeck-site' }
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers })
if (!res.ok) {
  console.error(`releases: GitHub answered ${res.status}; keeping the committed releases.json`)
  process.exit(0)
}
const releases = (await res.json())
  .filter((r) => !r.draft && !r.prerelease)
  .map((r) => ({
    tag: r.tag_name,
    name: r.name || r.tag_name,
    date: r.published_at,
    url: r.html_url,
    body: (r.body || '').replace(/\r\n/g, '\n').trim(),
    assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
  }))
writeFileSync(out, JSON.stringify(releases, null, 2) + '\n')
console.log(`releases: ${releases.length} written, latest ${releases[0]?.tag ?? 'none'}`)
