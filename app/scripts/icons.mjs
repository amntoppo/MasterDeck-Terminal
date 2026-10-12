// Renders MasterDeck's icons from one mark (the deck of three panes with a prompt, as on masterdeck.dev).
// Run on macOS after changing the mark: `node scripts/icons.mjs` (iconutil makes the .icns). The
// outputs are committed:
//   build/icon.svg, icon.png (1024), icon.icns, icon.ico  — the app (electron-builder's buildResources)
//   src/web/public/favicon.svg, apple-touch-icon.png, icon-192.png, icon-512.png — app.masterdeck.dev
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const root = resolve(import.meta.dirname, '..')
const build = join(root, 'build')
const web = join(root, 'src/web/public')
mkdirSync(build, { recursive: true })
mkdirSync(web, { recursive: true })

const GRAD = `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#79a8ff"/><stop offset="1" stop-color="#b08cff"/></linearGradient>`
// The mark on its 32-unit grid; its box is x 3..29, y 3..28.
const MARK = `<rect x="9" y="3" width="20" height="16" rx="4" fill="url(#g)" opacity="0.35"/>
  <rect x="6" y="7" width="20" height="16" rx="4" fill="url(#g)" opacity="0.6"/>
  <rect x="3" y="11" width="20" height="17" rx="4" fill="url(#g)"/>
  <path d="m8 17 3 2.5L8 22m5 0h5" fill="none" stroke="#07080b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`

/** The mark centred on a dark tile. `inset` is the empty margin around the tile (macOS draws its
 * icons on an 824 tile inside 1024), `radius` the tile's corners, `size` the mark's width. */
function tile({ inset, radius, size }) {
  const t = 1024 - inset * 2
  const s = size / 26
  const tx = 512 - 16 * s
  const ty = 512 - 15.5 * s
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>${GRAD}
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a1d27"/><stop offset="1" stop-color="#07080b"/></linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.3" r="0.7"><stop offset="0" stop-color="#79a8ff" stop-opacity="0.22"/><stop offset="1" stop-color="#79a8ff" stop-opacity="0"/></radialGradient>
</defs>
<rect x="${inset}" y="${inset}" width="${t}" height="${t}" rx="${radius}" fill="url(#bg)"/>
<rect x="${inset}" y="${inset}" width="${t}" height="${t}" rx="${radius}" fill="url(#glow)"/>
<rect x="${inset + 1.5}" y="${inset + 1.5}" width="${t - 3}" height="${t - 3}" rx="${radius - 1.5}" fill="none" stroke="#ffffff" stroke-opacity="0.08" stroke-width="3"/>
<g transform="translate(${tx} ${ty}) scale(${s})">${MARK}</g>
</svg>
`
}
const png = (svg, size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

// macOS: an 824 tile in 1024, the system's icon grid, so it sits with the other Dock icons.
const mac = tile({ inset: 100, radius: 185, size: 520 })
// Windows and the web: the tile fills the square (Windows draws icons edge to edge; iOS and
// Android round a full square themselves).
const full = tile({ inset: 0, radius: 0, size: 640 })
const rounded = tile({ inset: 16, radius: 220, size: 620 })

writeFileSync(join(build, 'icon.svg'), mac)
writeFileSync(join(build, 'icon.png'), png(mac, 1024))

// .icns through iconutil (macOS only).
const tmp = mkdtempSync(join(tmpdir(), 'md-icons-'))
const set = join(tmp, 'icon.iconset')
mkdirSync(set)
for (const n of [16, 32, 128, 256, 512]) {
  writeFileSync(join(set, `icon_${n}x${n}.png`), png(mac, n))
  writeFileSync(join(set, `icon_${n}x${n}@2x.png`), png(mac, n * 2))
}
execFileSync('iconutil', ['-c', 'icns', set, '-o', join(build, 'icon.icns')])
rmSync(tmp, { recursive: true, force: true })

// .ico: PNG entries (Windows Vista and later read them), the rounded tile.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map((n) => png(rounded, n))
const head = Buffer.alloc(6 + 16 * sizes.length)
head.writeUInt16LE(0, 0)
head.writeUInt16LE(1, 2)
head.writeUInt16LE(sizes.length, 4)
let offset = head.length
sizes.forEach((n, i) => {
  const e = 6 + i * 16
  head.writeUInt8(n === 256 ? 0 : n, e)
  head.writeUInt8(n === 256 ? 0 : n, e + 1)
  head.writeUInt16LE(1, e + 4)
  head.writeUInt16LE(32, e + 6)
  head.writeUInt32LE(images[i].length, e + 8)
  head.writeUInt32LE(offset, e + 12)
  offset += images[i].length
})
writeFileSync(join(build, 'icon.ico'), Buffer.concat([head, ...images]))

// The web app: the bare mark as the tab icon (as on masterdeck.dev), the tile for home screens.
writeFileSync(join(web, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><defs>${GRAD}</defs>${MARK}</svg>\n`)
writeFileSync(join(web, 'apple-touch-icon.png'), png(full, 180))
writeFileSync(join(web, 'icon-192.png'), png(full, 192))
writeFileSync(join(web, 'icon-512.png'), png(full, 512))
console.log('icons: build/icon.{svg,png,icns,ico}, src/web/public/{favicon.svg,apple-touch-icon.png,icon-192.png,icon-512.png}')
