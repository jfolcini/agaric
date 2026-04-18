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

import { dispatch } from './handlers'
import { clearMockErrors, getInjectedError, hasInjectedError, injectMockError } from './injection'
import { addMockAttachment, seedBlocks } from './seed'

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export { clearMockErrors, injectMockError } from './injection'
export { SEED_IDS } from './seed'

/** Reset mock state — clears and re-seeds the in-memory store. Useful for tests. */
export function resetMock(): void {
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
    if (hasInjectedError(cmd)) {
      // biome-ignore lint/style/noNonNullAssertion: hasInjectedError() guarantees getInjectedError() returns a string
      throw new Error(getInjectedError(cmd)!)
    }
    return dispatch(cmd, args)
  })

  // Expose error injection to E2E tests via window globals
  const w = window as unknown as Record<string, unknown>
  w['__injectMockError'] = injectMockError
  w['__clearMockErrors'] = clearMockErrors

  // Expose attachment seeding to E2E tests
  w['__addMockAttachment'] = addMockAttachment
}
