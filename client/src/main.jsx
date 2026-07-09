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

function markAppReady() {
  if (typeof window !== 'undefined') {
    window.__NEXUS_APP_READY = true;
  }
  document.getElementById('nexus-boot-shell')?.remove();
}

markAppReady()
