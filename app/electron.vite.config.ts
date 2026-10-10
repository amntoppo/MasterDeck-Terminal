import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        // capture: the meetings capture window's own preload (sandboxed; it only sends the recording to main).
        input: { index: resolve('src/preload/index.ts'), capture: resolve('src/preload/capture.ts') },
      },
    },
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rollupOptions: {
        // capture.html: the hidden meetings capture window (main/meetings/recorder.ts), no UI.
        input: { index: resolve('src/renderer/index.html'), capture: resolve('src/renderer/capture.html') },
      },
    },
  },
})
