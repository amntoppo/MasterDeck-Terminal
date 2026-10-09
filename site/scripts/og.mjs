// Renders the link-preview images (public/og/<page>.png, 1200×630), the favicon and the
// apple-touch icon. Run `npm run og` after changing a title or a screen; the PNGs are committed.
import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const pub = new URL('../public/', import.meta.url)
const PAGES = {
  home: ['The command center', 'for Claude Code', 'Every session in one window, with your board, PRs and costs.', 'sessions-list'],
  features: ['Everything around', 'the terminal', 'Sessions, board, workflows, costs, several accounts.', 'workflow-canvas'],
  docs: ['From install', 'to first session', 'Install, Setup, connect GitHub and a board.', 'board-tickets'],
  download: ['Download', 'MasterDeck', 'Free and open source for macOS and Windows.', 'costs-dashboard'],
}

const MARK = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})">
  <rect x="9" y="3" width="20" height="16" rx="4" fill="url(#g)" opacity="0.35"/>
  <rect x="6" y="7" width="20" height="16" rx="4" fill="url(#g)" opacity="0.6"/>
  <rect x="3" y="11" width="20" height="17" rx="4" fill="url(#g)"/>
  <path d="m8 17 3 2.5L8 22m5 0h5" fill="none" stroke="#07080b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`
const DEFS = `<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#79a8ff"/><stop offset="1" stop-color="#b08cff"/></linearGradient>
  <radialGradient id="glow" cx="0.75" cy="0.1" r="0.8"><stop offset="0" stop-color="#79a8ff" stop-opacity="0.28"/><stop offset="1" stop-color="#79a8ff" stop-opacity="0"/></radialGradient>
  <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#ffffff" stroke-opacity="0.04"/></pattern>
</defs>`

const font = `font-family="Geist, -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif"`
const render = (svg, width, out) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width }, resourcesDir: new URL('screens/', pub).pathname }).render().asPng()
  writeFileSync(new URL(out, pub), png)
}

for (const [key, [l1, l2, sub, screen]] of Object.entries(PAGES)) {
  // The screen goes in as a PNG: text inside a nested SVG image is not drawn.
  const shot = new Resvg(readFileSync(new URL(`screens/${screen}.svg`, pub)), { fitTo: { mode: 'width', value: 1240 } }).render().asPng().toString('base64')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1200" height="630" viewBox="0 0 1200 630">${DEFS}
  <rect width="1200" height="630" fill="#07080b"/><rect width="1200" height="630" fill="url(#grid)"/><rect width="1200" height="630" fill="url(#glow)"/>
  <g transform="translate(730 170) rotate(-4)">
    <rect x="-1" y="-1" width="622" height="420" rx="16" fill="#2a2d37"/>
    <rect width="620" height="418" rx="15" fill="#101217"/>
    <circle cx="20" cy="17" r="5" fill="#ff5f57"/><circle cx="38" cy="17" r="5" fill="#febc2e"/><circle cx="56" cy="17" r="5" fill="#28c840"/>
    <image x="0" y="34" width="620" height="388" preserveAspectRatio="xMinYMin slice" xlink:href="data:image/png;base64,${shot}"/>
  </g>
  ${MARK(64, 64, 1.6)}
  <text x="124" y="99" ${font} font-size="28" font-weight="600" fill="#eceef3">MasterDeck</text>
  <text x="64" y="300" ${font} font-size="64" font-weight="700" fill="#eceef3" letter-spacing="-2">${l1}</text>
  <text x="64" y="372" ${font} font-size="64" font-weight="700" fill="#79a8ff" letter-spacing="-2">${l2}</text>
  <text x="64" y="440" ${font} font-size="24" fill="#b9bdc8">${sub}</text>
  <text x="64" y="566" ${font} font-size="22" fill="#8b909c">masterdeck.dev</text>
</svg>`
  render(svg, 1200, `og/${key}.png`)
  console.log(`og/${key}.png`)
}

const icon = (bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">${DEFS}${bg}${MARK(0, 0, 1)}</svg>`
writeFileSync(new URL('favicon.svg', pub), icon('') + '\n')
render(icon('<rect width="32" height="32" rx="7" fill="#07080b"/>').replace(MARK(0, 0, 1), MARK(4, 3, 0.8)), 180, 'apple-touch-icon.png')
console.log('favicon.svg, apple-touch-icon.png')
