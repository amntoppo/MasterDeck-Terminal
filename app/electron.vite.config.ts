import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    // An update-test build (docs/OPERATIONS.md "Testing in-app updates") takes a test release key and
    // a local update service from the environment; a release build never does (shared/releaseKey.ts).
    define: { __MD_UPDATE_TEST__: JSON.stringify(process.env.MASTERDECK_UPDATE_TEST_BUILD === '1') },
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
    // The capture page's AudioWorklet (pcmWorklet.ts?worker&url): a module in the build as in
    // `npm run dev` (vite serves a worker file as a module there). A worklet scope has no
    // importScripts, and addModule loads modules.
    worker: { format: 'es' },
    build: {
      rollupOptions: {
        // capture.html: the hidden meetings capture window (main/meetings/recorder.ts), no UI.
        input: { index: resolve('src/renderer/index.html'), capture: resolve('src/renderer/capture.html') },
      },
    },
  },
})
