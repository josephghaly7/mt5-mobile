import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { registerSW } from 'virtual:pwa-register'

// Auto-update service worker (vite-plugin-pwa generates this).
// Bumps update available state to App for the "new version" toast.
registerSW({ onNeedRefresh: () => {
  const evt = new CustomEvent('sw-update-available')
  window.dispatchEvent(evt)
}})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
