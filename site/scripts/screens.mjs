// Draws the four placeholder screens of MasterDeck as SVG (1440×900), in the app's own palette.
// Usage (from site/): node scripts/screens.mjs public/screens. Delete a file here once it is a real screenshot.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2]
const W = 1440, H = 900
const C = {
  bg: '#0b0c0f', bg2: '#101217', bg3: '#161922', bg4: '#1c1f28', line: '#1f222b', line2: '#2a2d37',
  text: '#e8e8ec', muted: '#7c808c', faint: '#5d616c', accent: '#79a8ff', green: '#4fd49a',
  amber: '#d9a441', red: '#ff7a7a', purple: '#b08cff',
}
const SANS = `font-family="Geist, ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif"`
const MONO = `font-family="'Geist Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"`
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const t = (x, y, s, { size = 13, fill = C.text, w = 400, mono = false, anchor = 'start', op } = {}) =>
  `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="${w}" ${mono ? MONO : SANS}${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${op ? ` opacity="${op}"` : ''}>${esc(s)}</text>`
const r = (x, y, w, h, { fill = C.bg2, stroke, rx = 8, sw = 1, dash, op } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}${op ? ` opacity="${op}"` : ''}/>`
const dot = (x, y, fill, rad = 4) => `<circle cx="${x}" cy="${y}" r="${rad}" fill="${fill}"/>`
const line = (x1, y1, x2, y2, stroke = C.line, sw = 1) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}" stroke-width="${sw}"/>`
const chip = (x, y, s, color = C.muted, { bg = C.bg3, mono = true, size = 11 } = {}) => {
  const w = s.length * (size * 0.62) + 14
  return r(x, y, w, 20, { fill: bg, stroke: C.line2, rx: 5 }) + t(x + 7, y + 14, s, { size, fill: color, mono })
}
const avatar = (x, y, initials, color) =>
  `<circle cx="${x}" cy="${y}" r="10" fill="${color}"/>` + t(x, y + 3.5, initials, { size: 9, w: 600, anchor: 'middle', fill: '#0b0c0f' })

// The rail on the left, with one view lit.
const RAIL = ['terminal', 'board', 'pr', 'tasks', '', 'costs', 'janitor', 'notes', 'workflow']
function rail(active) {
  let s = r(0, 0, 56, H, { fill: C.bg2, rx: 0 }) + line(56, 0, 56, H)
  s += `<g transform="translate(14 16)"><rect width="28" height="28" rx="7" fill="url(#lg)"/><path d="m7 12 4 3-4 3m6 0h6" fill="none" stroke="#0b0c0f" stroke-width="2" stroke-linecap="round"/></g>`
  RAIL.forEach((k, i) => {
    if (!k) return
    const y = 70 + i * 46
    const on = k === active
    if (on) s += r(8, y, 40, 36, { fill: 'rgba(121,168,255,0.14)', rx: 9 })
    s += r(19, y + 9, 18, 18, { fill: 'none', stroke: on ? C.accent : C.faint, rx: 4, sw: 1.6 })
    if (k === 'terminal') s += dot(43, y + 6, C.amber, 5) + t(43, y + 9.5, '3', { size: 8, w: 700, anchor: 'middle', fill: '#0b0c0f' })
  })
  ;[0, 1, 2, 3].forEach((i) => (s += r(19, H - 190 + i * 44, 18, 18, { fill: 'none', stroke: C.faint, rx: 9, sw: 1.6 })))
  return s
}
function svg(body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(title)}">
<!-- Placeholder drawing of a MasterDeck screen. Replace with a real screenshot: see site/src/data/screens.ts. -->
<defs>
<linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#79a8ff"/><stop offset="1" stop-color="#b08cff"/></linearGradient>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#2a2d37"/></pattern>
<linearGradient id="bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#79a8ff"/><stop offset="1" stop-color="#79a8ff" stop-opacity="0.35"/></linearGradient>
<linearGradient id="glowg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#79a8ff" stop-opacity="0.25"/><stop offset="1" stop-color="#79a8ff" stop-opacity="0"/></linearGradient>
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${body}
</svg>
`
}
// The ★ Master column on the right.
function masterCol(x) {
  let s = r(x, 0, W - x, H, { fill: C.bg2, rx: 0 }) + line(x, 0, x, H)
  s += t(x + 18, 30, '★ Master', { size: 13, w: 600 }) + chip(x + 100, 16, 'master-agent', C.green)
  const L = [
    ['› /master', C.text], ['Sweep: 4 repos · 9 sessions', C.muted], ['', ''], ['● api-41 waits on a prompt', C.amber],
    ['✓ web-77 merged → Dev Done', C.green], ['⟳ docs-55 review relayed', C.purple], ['◐ PROPOSE acme/api#58', C.accent],
    ['  “Rate-limit webhooks”', C.muted], ['  → new session, Sonnet', C.muted], ['', ''], ['› yes, start #58', C.text],
    ['✓ api-58 started', C.green],
  ]
  L.forEach(([s2, c], i) => (s += t(x + 18, 70 + i * 22, s2, { size: 12, fill: c, mono: true })))
  s += r(x + 14, H - 52, W - x - 28, 36, { fill: C.bg3, stroke: C.line2 }) + t(x + 28, H - 29, '› ', { size: 12, mono: true, fill: C.accent })
  return s
}

// ---------- sessions ----------
function sessions() {
  let s = rail('terminal')
  const cx = 56, cw = 300
  s += r(cx, 0, cw, H, { fill: C.bg, rx: 0 }) + line(cx + cw, 0, cx + cw, H)
  s += t(cx + 18, 32, 'Sessions', { size: 15, w: 600 }) + chip(cx + 196, 17, 'Split', C.muted, { mono: false, size: 12 }) + chip(cx + 246, 17, '+ New', C.accent, { mono: false, size: 12 })
  s += r(cx + 14, 48, cw - 28, 28, { fill: C.bg2, stroke: C.line }) + t(cx + 26, 66, '⌕  Filters', { size: 12, fill: C.muted })
  const groups = [
    ['NEEDS YOU', C.amber, [['api-41 webhooks retry', 'acme/api #41', 'Permission: Bash(npm test)', '$2.14', true], ['docs-55 install guide', 'acme/docs #55', 'Asks: which branch?', '$0.88']]],
    ['WORKING', C.accent, [['api-58 rate-limit', 'acme/api #58', 'Edit src/limits.ts', '$0.41'], ['web-80 dark mode', 'acme/web #80', 'Bash npm run build', '$3.02'], ['cli-12 retries', 'acme/cli #12', 'Read lib/http.py', '$1.10']]],
    ['IN REVIEW', C.purple, [['web-77 checkout flow', 'acme/web #77', 'PR #212 · CI ✓ · 1 review', '$6.40']]],
    ['IDLE', C.muted, [['infra-9 terraform', 'acme/infra #9', 'Idle 42 min', '$0.95']]],
    ['MERGED', C.green, [['api-33 auth tokens', 'acme/api #33', 'PR #198 merged', '$4.21']]],
  ]
  let y = 100
  for (const [g, gc, rows] of groups) {
    s += t(cx + 18, y, g, { size: 10.5, w: 600, fill: gc, mono: true }) + t(cx + cw - 18, y, String(rows.length), { size: 10.5, fill: C.faint, anchor: 'end', mono: true })
    y += 12
    for (const [name, ticket, sub, cost, sel] of rows) {
      if (sel) s += r(cx + 8, y, cw - 16, 58, { fill: C.bg3, stroke: C.line2 }) + r(cx + 8, y + 10, 3, 38, { fill: C.accent, rx: 2 })
      s += dot(cx + 24, y + 20, gc) + t(cx + 36, y + 24, name, { size: 13, w: 550 })
      s += t(cx + cw - 20, y + 24, cost, { size: 11.5, fill: C.muted, anchor: 'end', mono: true })
      s += t(cx + 36, y + 43, `${ticket} · ${sub}`, { size: 11.5, fill: C.muted })
      y += 62
    }
    y += 16
  }
  // terminal
  const tx = cx + cw, tw = 1440 - tx - 360
  s += r(tx, 0, tw, H, { fill: '#0a0b0e', rx: 0 })
  const T = [
    ['╭─ Claude Code ─────────────────────────────', C.faint], ['│ api-41 · ~/code/api · webhooks-retry', C.muted], ['╰───────────────────────────────────────────', C.faint], ['', ''],
    ['> Retry failed webhook deliveries with backoff', C.text], ['', ''],
    ['● I’ll add a retry queue with exponential backoff.', C.text], ['', ''],
    ['● Update(src/webhooks/deliver.ts)', C.accent], ['  └  Added 38 lines, removed 6', C.muted],
    ['     41 + const delay = Math.min(30_000, 500 * 2 ** attempt)', C.green], ['     42 + await queue.schedule(event, { delay })', C.green],
    ['     43 - await send(event)', C.red], ['', ''],
    ['● Now let me run the tests.', C.text], ['', ''],
    ['╭──────────────────────────────────────────╮', C.amber], ['│ Bash command                               │', C.amber],
    ['│   npm test -- webhooks                     │', C.text], ['│ Do you want to proceed?                    │', C.amber],
    ['│ ❯ 1. Yes                                   │', C.accent], ['│   2. Yes, and don’t ask again for npm test │', C.muted],
    ['│   3. No, tell Claude what to do differently │', C.muted], ['╰──────────────────────────────────────────╯', C.amber],
  ]
  T.forEach(([l, c], i) => (s += t(tx + 24, 40 + i * 22, l, { size: 13, fill: c, mono: true })))
  s += r(tx + 20, H - 70, tw - 40, 44, { fill: C.bg2, stroke: C.line2 }) + t(tx + 36, H - 42, '? for shortcuts', { size: 12, fill: C.faint, mono: true })
  // details
  const dx = 1440 - 360
  s += r(dx, 0, 360, H, { fill: C.bg2, rx: 0 }) + line(dx, 0, dx, H)
  ;['Details', 'Queue', 'Summary'].forEach((k, i) => {
    s += t(dx + 22 + i * 82, 32, k, { size: 13, w: i ? 400 : 600, fill: i ? C.muted : C.text })
  })
  s += line(dx + 18, 44, dx + 74, 44, C.accent, 2) + line(dx, 45, W, 45)
  s += r(dx + 18, 64, 324, 74, { fill: 'rgba(217,164,65,0.08)', stroke: 'rgba(217,164,65,0.4)' })
  s += t(dx + 32, 88, 'Waiting on a permission prompt', { size: 13, w: 600, fill: C.amber }) + t(dx + 32, 108, 'Bash(npm test -- webhooks)', { size: 12, fill: C.text, mono: true })
  s += chip(dx + 32, 114, 'Open', C.accent, { mono: false, size: 11.5 })
  const kv = [['Status', 'Needs you'], ['Ticket', 'acme/api #41 · In Dev'], ['Branch', 'webhooks-retry ↑3'], ['PR', '—'], ['Model', 'Sonnet · default'], ['Account', '@acme-dev'], ['Workflow', 'Default']]
  kv.forEach(([k, v], i) => (s += t(dx + 22, 170 + i * 30, k, { size: 12.5, fill: C.muted }) + t(dx + 130, 170 + i * 30, v, { size: 12.5 })))
  s += t(dx + 22, 400, 'Context', { size: 12.5, fill: C.muted }) + r(dx + 130, 390, 190, 8, { fill: C.bg4, rx: 4 }) + r(dx + 130, 390, 112, 8, { fill: C.accent, rx: 4 }) + t(dx + 130, 418, '59% · 118k of 200k', { size: 11.5, fill: C.muted, mono: true })
  s += t(dx + 22, 450, 'Tokens', { size: 12.5, fill: C.muted }) + t(dx + 130, 450, '2.4M  ·  $2.14', { size: 12.5, mono: true })
  s += t(dx + 22, 492, 'Diff', { size: 12.5, fill: C.muted }) + t(dx + 130, 492, '+38  −6  · 2 files', { size: 12.5, mono: true, fill: C.green })
  ;['src/webhooks/deliver.ts', 'src/webhooks/queue.ts'].forEach((f, i) => (s += t(dx + 130, 516 + i * 20, f, { size: 11.5, mono: true, fill: C.muted })))
  ;['Continue', 'Compact', 'Open PR'].forEach((b, i) => (s += r(dx + 22 + i * 108, 580, 98, 32, { fill: C.bg3, stroke: C.line2 }) + t(dx + 71 + i * 108, 600, b, { size: 12.5, anchor: 'middle' })))
  return svg(s, 'MasterDeck Terminals view (placeholder)')
}

// ---------- board ----------
function board() {
  let s = rail('board')
  const x0 = 56
  s += t(x0 + 24, 36, 'Board', { size: 18, w: 600 })
  ;['acme', 'side-project'].forEach((k, i) => {
    const x = x0 + 100 + i * 120
    s += r(x, 18, 110, 28, { fill: i ? 'none' : C.bg3, stroke: i ? C.line : C.line2, rx: 14 }) + t(x + 55, 37, `@${k}`, { size: 12, anchor: 'middle', fill: i ? C.muted : C.text })
  })
  ;['Sprint 14 ▾', 'Assignee: me ▾', 'Repos ▾', 'Labels ▾'].forEach((k, i) => (s += r(x0 + 380 + i * 132, 18, 122, 28, { fill: C.bg2, stroke: C.line }) + t(x0 + 392 + i * 132, 37, k, { size: 12, fill: C.muted })))
  s += r(W - 300, 18, 124, 28, { fill: C.text, rx: 14 }) + t(W - 238, 37, '+ New ticket', { size: 12.5, w: 600, anchor: 'middle', fill: '#0b0c0f' })
  s += t(W - 150, 37, 'Summary · Refresh', { size: 12, fill: C.muted })
  s += line(x0, 64, W, 64)
  const cols = [
    ['Todo', C.muted, [
      ['Session templates', 'web', 88, null, '—', 'AT'], ['Export costs as CSV', 'web', 83, null, '—', 'JL'],
      ['Retry policy for the CLI', 'cli', 14, null, '—', 'AT'], ['Docs: first-run screenshots', 'docs', 60, null, '—', 'MK'], ['Paginate the audit log', 'api', 62, null, '—', 'JL'], ['Keyboard shortcuts sheet', 'web', 85, null, '—', 'MK'],
    ]],
    ['In Dev', C.accent, [
      ['Webhook deliveries retry with backoff', 'api', 41, 'needs', '$2.14', 'AT'], ['Dark mode for settings', 'web', 80, 'work', '$3.02', 'JL'],
      ['HTTP retries in the CLI', 'cli', 12, 'work', '$1.10', 'AT'], ['Install guide rewrite', 'docs', 55, 'needs', '$0.88', 'MK'], ['Rate-limit incoming webhooks', 'api', 58, 'work', '$0.41', 'AT'],
    ]],
    ['PR Raised', C.purple, [
      ['Checkout flow v2', 'web', 77, 'review', '$6.40', 'JL', 'PR #212 · ✓ CI'], ['Terraform state locking', 'infra', 9, 'idle', '$0.95', 'MK', 'PR #31 · 2 comments'], ['Search across sessions', 'web', 74, 'review', '$2.66', 'JL', 'PR #209 · ✓ CI'],
    ]],
    ['Done', C.green, [
      ['Short-lived auth tokens', 'api', 33, 'merged', '$4.21', 'AT', 'PR #198 · merged'], ['Release notes page', 'web', 71, 'merged', '$1.76', 'JL', 'PR #205 · merged'], ['Fix flaky e2e login', 'web', 69, 'merged', '$0.62', 'MK', 'PR #201 · merged'], ['Bump the Node runtime', 'infra', 7, 'merged', '$0.34', 'AT', 'PR #29 · merged'],
    ]],
  ]
  const cw = (W - x0 - 48 - 3 * 16) / 4
  const stateCol = { needs: C.amber, work: C.accent, review: C.purple, idle: C.muted, merged: C.green }
  const avCol = { AT: '#79a8ff', JL: '#b08cff', MK: '#4fd49a' }
  cols.forEach(([name, color, cards], i) => {
    const x = x0 + 24 + i * (cw + 16)
    s += r(x, 84, cw, H - 104, { fill: C.bg2, stroke: C.line, rx: 12 })
    s += dot(x + 20, 108, color) + t(x + 32, 112, name, { size: 13.5, w: 600 }) + t(x + cw - 18, 112, String(cards.length), { size: 12, fill: C.faint, anchor: 'end', mono: true })
    let y = 128
    cards.forEach(([title, repo, n, state, cost, av, pr], j) => {
      const h = pr ? 120 : 100
      const lift = i === 1 && j === 0
      s += r(x + 10, y, cw - 20, h, { fill: C.bg3, stroke: lift ? C.accent : C.line2, rx: 10, sw: lift ? 1.5 : 1 })
      s += t(x + 24, y + 26, `acme/${repo} #${n}`, { size: 11.5, fill: C.muted, mono: true })
      s += t(x + 24, y + 50, title.length > 34 ? title.slice(0, 33) + '…' : title, { size: 13.5, w: 550 })
      const sy = pr ? y + 74 : y + 76
      if (pr) s += t(x + 24, y + 74, pr, { size: 11.5, fill: state === 'merged' ? C.green : C.purple, mono: true })
      const by = pr ? y + 92 : y + 66
      s += state ? dot(x + 28, by + 13, stateCol[state]) + t(x + 38, by + 17, state === 'needs' ? 'Needs you' : state === 'work' ? 'Working' : state === 'review' ? 'In review' : state === 'idle' ? 'Idle' : 'Merged', { size: 11.5, fill: stateCol[state] }) : t(x + 24, by + 17, '○ no session', { size: 11.5, fill: C.faint })
      s += t(x + cw - 60, by + 17, cost, { size: 11.5, fill: C.muted, mono: true, anchor: 'end' }) + avatar(x + cw - 36, by + 13, av, avCol[av])
      void sy
      y += h + 10
    })
  })
  return svg(s, 'MasterDeck Board (placeholder)')
}

// ---------- workflow ----------
function workflow() {
  let s = rail('workflow')
  const x0 = 56, pw = 250
  s += r(x0, 0, pw, H, { fill: C.bg2, rx: 0 }) + line(x0 + pw, 0, x0 + pw, H)
  s += r(x0 + 14, 16, pw - 28, 30, { fill: C.bg, stroke: C.line2 }) + t(x0 + 26, 36, '⌕  Search blocks', { size: 12, fill: C.faint })
  const groups = [
    ['TRIGGERS', C.accent, ['Session starts', 'Linked to its issue', 'After a git push', 'Before the PR', 'PR merged', 'Turn finished', 'Idle for N minutes']],
    ['SKILLS', C.purple, ['/review', '/test-fix', '/changelog', 'acme:deploy-preview']],
    ['BUILT-INS', C.green, ['Board moves', 'Self-review gate', 'PR watch']],
    ['ACTIONS', C.amber, ['Instruction', 'Notify me']],
  ]
  let y = 76
  for (const [g, c, items] of groups) {
    s += t(x0 + 18, y, g, { size: 10.5, w: 600, fill: c, mono: true })
    y += 12
    for (const it of items) {
      s += r(x0 + 14, y, pw - 28, 28, { fill: C.bg3, stroke: C.line, rx: 7 }) + r(x0 + 24, y + 10, 8, 8, { fill: c, rx: 2 }) + t(x0 + 42, y + 18.5, it, { size: 12.5 })
      y += 34
    }
    y += 14
  }
  const cx = x0 + pw
  s += `<rect x="${cx}" y="0" width="${W - cx}" height="${H}" fill="url(#dots)"/>`
  // toolbar
  s += r(cx, 0, W - cx, 56, { fill: C.bg, rx: 0 }) + line(cx, 56, W, 56)
  s += t(cx + 22, 34, 'Workflow', { size: 16, w: 600 }) + chip(cx + 112, 19, 'Default ▾', C.text, { mono: false, size: 12 })
  ;['then', 'if it worked', 'if it failed'].forEach((k, i) => {
    const col = [C.accent, C.green, C.red][i]
    const x = cx + 260 + i * 118
    s += r(x, 16, 110, 26, { fill: i ? C.bg2 : 'rgba(121,168,255,0.14)', stroke: C.line2, rx: 6 }) + line(x + 10, 29, x + 28, 29, col, 2) + t(x + 36, 33, k, { size: 12, fill: i ? C.muted : C.text })
  })
  s += t(cx + 640, 33, 'Tidy up', { size: 12.5, fill: C.muted }) + t(cx + 712, 33, 'All hooks', { size: 12.5, fill: C.muted })
  s += r(W - 210, 14, 190, 30, { fill: 'url(#lg)', rx: 15 }) + t(W - 115, 34, '✦ Build with Claude', { size: 12.5, w: 600, anchor: 'middle', fill: '#0b0c0f' })
  // nodes
  const N = {
    start: [cx + 60, 130, 'TRIGGER', 'Session starts', C.accent],
    link: [cx + 320, 130, 'BUILT-IN', 'Link issue · card → In Dev', C.green],
    push: [cx + 60, 330, 'TRIGGER', 'After a git push', C.accent],
    tests: [cx + 320, 330, 'INSTRUCTION', 'Run the test suite', C.amber],
    fix: [cx + 600, 440, 'SKILL', '/test-fix', C.purple],
    preview: [cx + 600, 240, 'SKILL', 'acme:deploy-preview', C.purple],
    pre: [cx + 60, 600, 'TRIGGER', 'Before the PR', C.accent],
    review: [cx + 320, 600, 'BUILT-IN', 'Self-review gate', C.green],
    watch: [cx + 600, 640, 'BUILT-IN', 'PR watch', C.green],
    notify: [cx + 860, 440, 'ACTION', 'Notify me', C.amber],
  }
  const NW = 210, NH = 66
  const edge = (a, b, col, dash) => {
    const [ax, ay] = N[a], [bx, by] = N[b]
    const x1 = ax + NW, y1 = ay + NH / 2, x2 = bx, y2 = by + NH / 2, dx = Math.max(40, (x2 - x1) / 2)
    return `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" fill="none" stroke="${col}" stroke-width="2"${dash ? ' stroke-dasharray="6 6"' : ''}/>` + dot(x2, y2, col, 3.5)
  }
  s += edge('start', 'link', C.accent) + edge('push', 'tests', C.accent) + edge('tests', 'preview', C.green, 1) + edge('tests', 'fix', C.red, 1)
  s += edge('pre', 'review', C.accent) + edge('review', 'watch', C.accent) + edge('fix', 'notify', C.red, 1)
  for (const [k, [x, y, tag, label, col]] of Object.entries(N)) {
    const sel = k === 'tests'
    s += r(x, y, NW, NH, { fill: C.bg3, stroke: sel ? C.accent : C.line2, rx: 10, sw: sel ? 1.6 : 1 })
    if (sel) s += r(x - 4, y - 4, NW + 8, NH + 8, { fill: 'none', stroke: 'rgba(121,168,255,0.25)', rx: 13, sw: 3 })
    s += r(x, y + 12, 3, NH - 24, { fill: col, rx: 2 })
    s += t(x + 16, y + 25, tag, { size: 10, w: 600, fill: col, mono: true }) + t(x + 16, y + 48, label, { size: 13.5, w: 550 })
    s += dot(x + NW, y + NH / 2, C.line2, 4)
  }
  // settings card of the selected block
  const sx = W - 316, sy = 600
  s += r(sx, sy, 300, 214, { fill: C.bg2, stroke: C.line2, rx: 12 })
  s += t(sx + 18, sy + 30, 'Run the test suite', { size: 14, w: 600 }) + t(sx + 280, sy + 30, '×', { size: 16, fill: C.muted, anchor: 'end' })
  s += t(sx + 18, sy + 58, 'Instruction', { size: 11.5, fill: C.muted })
  s += r(sx + 18, sy + 68, 264, 64, { fill: C.bg, stroke: C.line2 })
  ;['Run npm test. Report failures', 'with the file and assertion.'].forEach((l, i) => (s += t(sx + 30, sy + 92 + i * 20, l, { size: 12, mono: true, fill: C.text })))
  s += t(sx + 18, sy + 160, 'Runs', { size: 11.5, fill: C.muted }) + chip(sx + 18, sy + 170, 'in the session', C.text, { mono: false, size: 11.5 }) + chip(sx + 130, sy + 170, 'in a subagent', C.muted, { mono: false, size: 11.5 })
  return svg(s, 'MasterDeck Workflow canvas (placeholder)')
}

// ---------- costs ----------
function costs() {
  let s = rail('costs')
  const x0 = 56 + 32
  s += t(x0, 44, 'Costs', { size: 22, w: 600 })
  const tg = ['USD', 'Tokens', 'Hours']
  tg.forEach((k, i) => (s += r(W - 300 + i * 88, 22, 84, 32, { fill: i ? C.bg2 : 'rgba(121,168,255,0.14)', stroke: i ? C.line : C.accent, rx: 8 }) + t(W - 258 + i * 88, 43, k, { size: 13, anchor: 'middle', fill: i ? C.muted : C.text, w: i ? 400 : 600 })))
  const tiles = [['Today', '$18.42', '+12% vs avg', C.amber], ['7 days', '$96.10', '41 sessions', C.muted], ['30 days', '$352.77', '23 tickets', C.muted], ['All time', '$1,204.55', 'since Sep 2', C.muted]]
  const tw = (W - x0 - 32 - 3 * 16) / 4
  tiles.forEach(([k, v, sub, sc], i) => {
    const x = x0 + i * (tw + 16)
    s += r(x, 76, tw, 108, { fill: C.bg2, stroke: C.line, rx: 12 })
    s += t(x + 20, 104, k, { size: 12.5, fill: C.muted }) + t(x + 20, 146, v, { size: 30, w: 650 }) + t(x + 20, 170, sub, { size: 12, fill: sc })
  })
  // chart
  const cy = 204, ch = 300, cw = W - x0 - 32
  s += r(x0, cy, cw, ch, { fill: C.bg2, stroke: C.line, rx: 12 })
  s += t(x0 + 20, cy + 32, 'Last 14 days', { size: 14, w: 600 }) + t(x0 + 124, cy + 32, 'per day, USD', { size: 12, fill: C.muted })
  const vals = [6.2, 9.8, 4.1, 12.5, 14.2, 3.0, 2.1, 11.4, 16.8, 13.1, 19.6, 8.7, 15.3, 18.4]
  const max = 20, bx0 = x0 + 64, bw = (cw - 100) / 14, base = cy + ch - 40, hmax = ch - 100
  ;[0, 5, 10, 15, 20].forEach((g) => {
    const gy = base - (g / max) * hmax
    s += line(bx0 - 8, gy, x0 + cw - 20, gy, C.line) + t(bx0 - 16, gy + 4, `$${g}`, { size: 11, fill: C.faint, anchor: 'end', mono: true })
  })
  vals.forEach((v, i) => {
    const h = (v / max) * hmax, x = bx0 + i * bw + bw * 0.2
    const last = i === vals.length - 1
    s += r(x, base - h, bw * 0.6, h, { fill: last ? C.accent : 'url(#bar)', rx: 4 })
    s += t(x + bw * 0.3, base + 20, `${i + 27 > 30 ? i - 3 : i + 27}`, { size: 11, fill: last ? C.text : C.faint, anchor: 'middle', mono: true })
  })
  const lx = bx0 + 13 * bw + bw * 0.5
  s += r(lx - 120, base - (18.4 / max) * hmax - 46, 104, 34, { fill: C.bg4, stroke: C.line2, rx: 7 }) + t(lx - 68, base - (18.4 / max) * hmax - 24, 'Today $18.42', { size: 12, anchor: 'middle', mono: true })
  // tables
  const ty = cy + ch + 20, tw2 = (cw - 16) / 2
  const table = (x, title, head, rows, bars) => {
    let q = r(x, ty, tw2, H - ty - 24, { fill: C.bg2, stroke: C.line, rx: 12 })
    q += t(x + 20, ty + 32, title, { size: 14, w: 600 })
    head.forEach((h, i) => (q += t(x + 20 + [0, 250, 360, 470][i], ty + 62, h, { size: 11.5, fill: C.muted })))
    q += line(x + 16, ty + 72, x + tw2 - 16, ty + 72)
    rows.forEach((row, j) => {
      const yy = ty + 98 + j * 34
      row.forEach((c, i) => (q += t(x + 20 + [0, 250, 360, 470][i], yy, c, { size: 13, mono: i > 0, fill: i === 0 ? C.text : C.text })))
      if (bars) q += r(x + tw2 - 110, yy - 10, 86 * (parseFloat(row[1].slice(1)) / 7), 6, { fill: C.accent, rx: 3, op: 0.6 })
    })
    return q
  }
  s += table(x0, 'Per ticket', ['Ticket', 'Spend', 'Tokens', 'Sessions'], [
    ['acme/web #77 Checkout v2', '$6.40', '7.1M', '2'], ['acme/api #33 Auth tokens', '$4.21', '4.9M', '1'], ['acme/web #80 Dark mode', '$3.02', '3.3M', '1'], ['acme/api #41 Webhooks', '$2.14', '2.4M', '1'], ['acme/web #71 Releases', '$1.76', '1.9M', '1'], ['acme/cli #12 HTTP retries', '$1.10', '1.2M', '1'],
  ], true)
  s += table(x0 + tw2 + 16, 'Per session', ['Session', 'Spend', 'Tokens', 'Model'], [
    ['web-77 checkout flow', '$5.10', '5.8M', 'Opus'], ['api-33 auth tokens', '$4.21', '4.9M', 'Sonnet'], ['web-80 dark mode', '$3.02', '3.3M', 'Sonnet'], ['api-41 webhooks', '$2.14', '2.4M', 'Sonnet'], ['web-77 review', '$1.30', '1.3M', 'Haiku'], ['cli-12 retries', '$1.10', '1.2M', 'Sonnet'],
  ])
  return svg(s, 'MasterDeck Costs view (placeholder)')
}

const files = { 'sessions-list.svg': sessions(), 'board-tickets.svg': board(), 'workflow-canvas.svg': workflow(), 'costs-dashboard.svg': costs() }
for (const [f, c] of Object.entries(files)) {
  writeFileSync(join(OUT, f), c)
  console.log(f, c.length)
}
void masterCol
