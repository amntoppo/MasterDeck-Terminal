import { createRoot } from 'react-dom/client'
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@renderer/styles.css'
import './web.css'
import { Gate } from './Gate'

createRoot(document.getElementById('root')!).render(<Gate />)
