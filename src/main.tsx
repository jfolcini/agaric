import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './lib/i18n'

import './index.css'
import { App } from './App.tsx'
import { ErrorBoundary } from './components/ErrorBoundary'
import { PrimaryFocusProvider } from './hooks/usePrimaryFocus'
import { logger } from './lib/logger'

// Global catch-all: capture uncaught errors and unhandled rejections
// before React mounts, so even early failures are logged persistently.
window.addEventListener('error', (event) => {
  logger.error('global', event.message || 'Uncaught error', {
    filename: event.filename ?? '',
    lineno: event.lineno ?? 0,
    colno: event.colno ?? 0,
    stack: event.error?.stack ?? '',
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  const message = reason instanceof Error ? reason.message : String(reason ?? 'Unhandled rejection')
  const stack = reason instanceof Error ? reason.stack : undefined
  logger.error('global', message, { stack: stack ?? '' })
})

async function main() {
  // When running in a regular browser (not Tauri webview), activate IPC mocks
  // so the UI renders for visual development/debugging.
  //
  // The `import.meta.env.PROD` check lets Vite tree-shake the entire
  // `tauri-mock` chunk out of the production bundle (PROD is statically
  // `true` in `vite build`). The runtime `__TAURI_INTERNALS__` check is
  // retained for the dev/test paths where PROD is `false`.
  if (!import.meta.env.PROD && !window.__TAURI_INTERNALS__) {
    const { setupMock } = await import('./lib/tauri-mock')
    setupMock()
  }

  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('Root element not found')
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <PrimaryFocusProvider>
          <App />
        </PrimaryFocusProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

main()
