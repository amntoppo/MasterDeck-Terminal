import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'
import { bootTheme } from './theme'

bootTheme()

createRoot(document.getElementById('root')!).render(<App />)
