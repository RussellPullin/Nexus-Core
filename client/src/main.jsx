import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

const rootEl = document.getElementById('root')
if (!rootEl) {
  throw new Error('Nexus Core root element missing')
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

document.getElementById('nexus-boot-shell')?.remove()
