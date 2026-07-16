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

  mockIPC((cmd, args) => {
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
  })

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
}
