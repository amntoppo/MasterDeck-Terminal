/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@renderer/styles.css'
import './web.css'
import { Gate } from './Gate'

const root = createRoot(document.getElementById('root')!)
const preview = new URLSearchParams(location.search).get('preview')
// Dev server only (?preview, ?preview=gate): the app on fixture data, no Mac or sign-in. Dropped from build:web.
if (import.meta.env.DEV && preview !== null) void import('./preview/preview').then((m) => m.mountPreview(root, preview))
else root.render(<Gate />)
