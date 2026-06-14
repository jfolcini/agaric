import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './lib/i18n'

import './index.css'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { TooltipProvider } from '@/components/ui/tooltip'

import { App } from './App.tsx'
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
          {/*
           * App-level tooltip baseline (#1094). One provider here means every
           * surface shares a single hover-delay source of truth instead of each
           * wrapping its own (24 surfaces + the IconButton primitive used to).
           *
           * delayDuration=300 is the standard Radix/UX baseline — a short but
           * non-zero hover dwell that feels intentional without lagging. It
           * sits between the old per-surface drift (0 / 200 / 500). Surfaces
           * with a deliberate deviation set delayDuration on their own
           * <Tooltip> (sidebar 0, toolbars 200, gutter 500) so the override
           * stays explicit rather than silently inheriting this baseline.
           *
           * skipDelayDuration=300 (Radix default) keeps the "move between
           * adjacent tooltips without re-waiting" window short.
           */}
          <TooltipProvider delayDuration={300} skipDelayDuration={300}>
            <App />
          </TooltipProvider>
        </PrimaryFocusProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

main()
