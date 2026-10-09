import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

export default defineConfig({
  site: 'https://masterdeck.dev',
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'auto' },
  integrations: [sitemap({ filter: (page) => !page.includes('/404') })],
})
