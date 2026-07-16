import { expect, test } from './helpers'

/**
 * E2E — `sync:complete` / `sync:error` Tauri events (#2683).
 *
 * `useSyncEvents` (mounted globally in `App.tsx`) listens for these two
 * backend events via `@tauri-apps/api/event`'s `listen()` and drives a
 * toast + the sync store. Before #2683, the tauri-mock's `plugin:event|listen`
 * / `|emit` were no-ops — no spec could ever deliver an event to a
 * registered `listen()` callback, so this flow (and every other
 * backend-event-driven flow) was structurally untestable in e2e.
 *
 * `setupMock()` now passes `{ shouldMockEvents: true }` to `mockIPC`
 * (`src/lib/tauri-mock/index.ts`), which activates `@tauri-apps/api/mocks`'
 * own real event bus, and exposes `window.__emitMockEvent(event, payload)`
 * so a spec can fire a backend event exactly as `@tauri-apps/api/event`'s
 * `emit()` would.
 */

interface MockEventWindow extends Window {
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

async function emitMockEvent(
  page: import('@playwright/test').Page,
  event: string,
  payload: unknown,
) {
  await page.evaluate(
    ({ event: evt, payload: data }) =>
      (window as unknown as MockEventWindow).__emitMockEvent?.(evt, data),
    { event, payload },
  )
}

test.describe('sync events (#2683)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('sync:complete shows the ops-received toast', async ({ page }) => {
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 2,
      ops_sent: 0,
    })

    await expect(page.getByText('Synced 2 changes from device')).toBeVisible()
  })

  test('sync:complete with zero ops received shows no toast', async ({ page }) => {
    // `useSyncEvents` only toasts when `ops_received > 0` — a heartbeat
    // sync that received nothing new should stay silent.
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 0,
      ops_sent: 0,
    })

    await expect(page.getByText(/Synced \d+ changes? from device/)).not.toBeVisible()
  })

  test('sync:error shows the failure toast with the backend message', async ({ page }) => {
    await emitMockEvent(page, 'sync:error', {
      type: 'error',
      remote_device_id: 'device-b',
      message: 'Connection refused',
    })

    await expect(page.getByText('Sync failed: Connection refused')).toBeVisible()
  })
})
