/**
 * Browser mock for Tauri IPC — enables the frontend to render in Chrome
 * without the Tauri backend. Used for visual development/debugging only.
 *
 * Activated automatically when `window.__TAURI_INTERNALS__` is absent
 * (i.e., running in a regular browser instead of the Tauri webview).
 *
 * This barrel is the public surface. Internal modules:
 *   - `seed.ts`      — shared state, seed data, helpers
 *   - `handlers.ts`  — per-command dispatch map
 *   - `injection.ts` — error-injection utilities for E2E tests
 */

import { emit } from '@tauri-apps/api/event'
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'

import { dispatch } from '@/lib/tauri-mock/handlers'
import { clearMockErrors, getInjectedError, injectMockError } from '@/lib/tauri-mock/injection'
import {
  addMockAgendaItems,
  addMockAttachment,
  addMockAttachmentWithBytes,
  seedBlocks,
} from '@/lib/tauri-mock/seed'

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export { clearMockErrors, injectMockError } from '@/lib/tauri-mock/injection'
export { SEED_IDS } from '@/lib/tauri-mock/seed'

/** Reset mock state — clears and re-seeds the in-memory store. Useful for tests. */
export function resetMock(): void {
  clearMockErrors()
  seedBlocks()
}

/**
 * Fully reset the mock's module-scoped in-memory state back to the
 * canonical seed. Safe to call between Playwright tests to avoid parallel
 * Mock-state collision (). Idempotent.
 *
 * Resets:
 *   - `blocks`, `properties`, `blockTags`, `propertyDefs`, `pageAliases`,
 *     `attachments` (cleared + reseeded by `seedBlocks()`)
 *   - `opLog` + its seq counter (cleared + reset by `seedBlocks()`)
 *   - `fakeId()` counter (reset by `seedBlocks()`)
 *   - Error-injection map (via `clearMockErrors()`)
 *
 * Does NOT touch:
 *   - `window.localStorage` (handled by Playwright `storageState` / test options)
 *   - Zustand stores (React component state lives in the page context)
 *   - Any browser navigation state (tests call `page.goto('/')` as needed)
 */
export function __resetTauriMock__(): void {
  clearMockErrors()
  seedBlocks()
}

export function setupMock(): void {
  // Fake the window label so getCurrent() works
  mockWindows('main')

  // Populate seed data for browser preview
  seedBlocks()

  mockIPC(
    (cmd, args) => {
      // Error injection — E2E tests can force any command to fail
      const injectedError = getInjectedError(cmd)
      if (injectedError !== undefined) {
        // String injections throw a plain Error (non-IPC-shaped failure);
        // structured AppError injections are thrown raw, mirroring a real
        // Tauri command rejection (#2251).
        if (typeof injectedError === 'string') throw new Error(injectedError)
        // Deliberately the raw `{ kind, message, code? }` wire object, exactly
        // as Tauri rejects (now a typed AppError, so no lint suppression needed).
        throw injectedError
      }
      return dispatch(cmd, args)
    },
    // #2683 — `shouldMockEvents` turns on `@tauri-apps/api/mocks`' own
    // `plugin:event|listen` / `|unlisten` / `|emit` handling: `listen()`
    // callbacks are retained in a real Map keyed by event name and an
    // `emit()` call actually invokes them with the `{event, payload}` shape
    // `@tauri-apps/api/event`'s `listen()` hands to callers. Without this,
    // those three commands fell through to `dispatch()`'s stub handlers
    // (`handlers.ts` PLUGIN_HANDLERS), which return an id / null and never
    // deliver anything — every backend-event-driven flow (sync toasts,
    // deep-link routing, MCP activity feed, property-changed reactions) was
    // structurally untestable in e2e.
    //
    // `plugin:event|emit_to` is ALSO intercepted once `shouldMockEvents` is
    // on — `@tauri-apps/api/mocks`' internal `isEventPluginInvoke()` matches
    // on the whole `plugin:event|` prefix, so `emit_to` never reaches this
    // callback (and therefore never reaches `dispatch()`'s stub either); its
    // internal switch has no `emit_to` case, so the call silently resolves
    // to `undefined` instead of `dispatch()`'s `null`. Verified empirically
    // (a `cb` passed here is never invoked for `emit_to` when
    // `shouldMockEvents: true`). Harmless today because no production code
    // calls `emitTo()` (grepped `src/`), but `handlers.ts`'s
    // `'plugin:event|emit_to': returnNull` entry is dead in this runtime
    // path regardless — same as `listen` / `unlisten` / `emit` — see the
    // comment on `PLUGIN_HANDLERS` there.
    { shouldMockEvents: true },
  )

  // Expose error injection to E2E tests via window globals
  const w = window as unknown as Record<string, unknown>
  w['__injectMockError'] = injectMockError
  w['__clearMockErrors'] = clearMockErrors

  // Expose attachment seeding to E2E tests
  w['__addMockAttachment'] = addMockAttachment
  // #1452 — seed a PDF attachment WITH real bytes so the annotation viewer
  // can parse it with pdf.js.
  w['__addMockAttachmentWithBytes'] = addMockAttachmentWithBytes

  // Expose bulk agenda-item seeding to E2E tests (#548 virtualization spec).
  w['__addMockAgendaItems'] = addMockAgendaItems

  // Expose the full reset hook to E2E tests. Wired into a global
  // beforeEach in `e2e/helpers.ts` so every spec starts from seed state.
  w['__resetTauriMock__'] = __resetTauriMock__

  // #2683 — expose a way for E2E tests to fire a backend event. Goes
  // through the REAL `@tauri-apps/api/event` `emit()`, so it exercises the
  // exact `plugin:event|emit` invoke path production code's `listen()`
  // callbacks are registered against (see the `shouldMockEvents` mockIPC
  // option above) rather than reaching into mock internals. Any listener
  // registered via `listen(event, handler)` — `useSyncEvents`,
  // `useDeepLinkRouter`, `useBlockPropertyEvents`, `useMcpActivityFeed`,
  // etc. — receives `{ event, payload }`, matching what a real Tauri
  // backend event delivers.
  w['__emitMockEvent'] = (event: string, payload?: unknown): Promise<void> => emit(event, payload)
}
