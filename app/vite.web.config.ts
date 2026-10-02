import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.MD_API ?? 'https://dev.masterdeck.dev'

/** Local backend (wrangler dev): let the CSP reach it. Only when MD_API points at localhost. */
const localCsp = (): Plugin => ({
  name: 'md-local-csp',
  transformIndexHtml: (html) =>
    API.startsWith('http://localhost') ? html.replace('connect-src ', `connect-src ${API} ${API.replace(/^http/, 'ws')} `) : html,
})

/** The web app (app.masterdeck.dev): the renderer again, with window.deck talking to the Mac through the relay. */
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  plugins: [react(), localCsp()],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@renderer': resolve(__dirname, 'src/renderer/src') } },
  define: { __MD_API__: JSON.stringify(API) },
  build: { outDir: resolve(__dirname, 'out/web'), emptyOutDir: true },
})
