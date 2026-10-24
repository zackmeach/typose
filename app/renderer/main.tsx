import { createRoot } from 'react-dom/client'
import type { TyposeApi } from '../shared/protocol'
import { App } from './App'
import { CoreClient } from './core'
import './style.css'

declare global {
  interface Window {
    typose: TyposeApi
  }
}

createRoot(document.getElementById('root')!).render(<App core={new CoreClient()} />)
