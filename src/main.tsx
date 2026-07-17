import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '@/lib/i18n'

import '@/index.css'
import { App } from '@/App.tsx'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { TooltipProvider } from '@/components/ui/tooltip'
import { PrimaryFocusProvider } from '@/hooks/usePrimaryFocus'
import { useTooltipDelay } from '@/hooks/useTooltipDelay'
import { logger } from '@/lib/logger'
import { initFrontendObservability } from '@/lib/observability'
import { queryClient } from '@/lib/query-client'

/**
 * App-level tooltip baseline (#1094, made user-tunable in #2851). One
 * provider here means every surface shares a single hover-delay source of
 * truth instead of each wrapping its own (24 surfaces + the IconButton
 * primitive used to).
 *
 * `main()` below is not a component, so it can't call `useTooltipDelay`
 * itself — this thin wrapper resolves the preference (default `300` ms,
 * matching the pre-#2851 constant so nothing changes for existing users)
 * and threads it into the provider. Surfaces with a deliberate deviation
 * still set `delayDuration` on their own `<Tooltip>` (sidebar 0, toolbars
 * 200, gutter 500) so the override stays explicit rather than silently
 * inheriting this baseline.
 *
 * `skipDelayDuration` tracks the same value, keeping the "move between
 * adjacent tooltips without re-waiting" window consistent with the chosen
 * dwell.
 */
function AppRoot() {
  const { delayMs } = useTooltipDelay()
  return (
    <TooltipProvider delayDuration={delayMs} skipDelayDuration={delayMs}>
      <App />
    </TooltipProvider>
  )
}

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
  // `tauri-mock` chunk out of the *shipped* production bundle (PROD is
  // statically `true` in `vite build`, so the `!PROD` arm folds to `false`
  // and the dynamic import is dropped). The runtime `__TAURI_INTERNALS__`
  // check is retained for the dev/test paths where PROD is `false`.
  //
  // `VITE_E2E` (#1458): the Playwright e2e suite no longer runs against the
  // HMR `vite dev` server (which stalled under shard load and cascaded a
  // random shard to the 20m CI cap). It runs against a *production* build
  // served by `vite preview`. A prod build sets PROD=`true`, which would
  // tree-shake the mock the suite depends on — so an explicit, build-time
  // `VITE_E2E=1` keeps the mock in that one build. `import.meta.env.VITE_E2E`
  // is statically `undefined` in a normal `npm run build` (the env var is
  // unset), so the OR arm folds to `false` and the shipped bundle is mock-free
  // exactly as before — the tree-shake win is preserved for real releases.
  if ((!import.meta.env.PROD || import.meta.env.VITE_E2E) && !window.__TAURI_INTERNALS__) {
    const { setupMock } = await import('@/lib/tauri-mock')
    setupMock()
  }

  // Initialise frontend observability (#2110, M3b). Off by default — this is a
  // no-op unless explicitly enabled (window.__AGARIC_OTEL__ / VITE_OTEL_FRONTEND),
  // in which case it lazily registers the tracer + installs the invoke
  // trace-context propagation patch. Awaited (after mock setup so the IPC bridge
  // exists) so the patch is in place before the app dispatches its first command.
  await initFrontendObservability()

  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('Root element not found')
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        {/*
         * Single app-root QueryClient provider (#2596). The migrated read-path
         * hooks pass this same client explicitly, so the provider is the
         * idiomatic root wiring / Devtools anchor rather than the only way the
         * client is reached. Read-path only — never the op_log write path.
         */}
        <QueryClientProvider client={queryClient}>
          <PrimaryFocusProvider>
            <AppRoot />
          </PrimaryFocusProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}

main()
