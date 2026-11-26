import type { Page } from '@playwright/test'

import { emitMockEvent, expect, navigateToView, openSettingsTab, syncButton, test } from './helpers'

/**
 * E2E — `sync:complete` / `sync:error` Tauri events (#2683).
 *
 * `useSyncEvents` (mounted globally in `App.tsx`) listens for these two
 * backend events via `@tauri-apps/api/event`'s `listen()` and drives the sync
 * store the sidebar Sync button shows. Before #2683, the tauri-mock's
 * `plugin:event|listen` / `|emit` were no-ops — no spec could ever deliver an
 * event to a registered `listen()` callback, so this flow (and every other
 * backend-event-driven flow) was structurally untestable in e2e.
 *
 * `setupMock()` now passes `{ shouldMockEvents: true }` to `mockIPC`
 * (`src/lib/tauri-mock/index.ts`), which activates `@tauri-apps/api/mocks`'
 * own real event bus, and exposes `window.__emitMockEvent(event, payload)`
 * so a spec can fire a backend event exactly as `@tauri-apps/api/event`'s
 * `emit()` would.
 *
 * #6870: background sync raises no toast; a pressed Sync's toasts are in
 * `sync-happy-paths.spec.ts`. The clock is paused once the view is up, and run
 * past sonner's zero-delay mount before toasts are counted, so a toast an event
 * raised would be on screen.
 */

/** Pause the clock, so only `runFor` moves it. */
async function pauseClock(page: Page): Promise<void> {
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
}

/** Fire the zero-delay timer sonner mounts a toast on, then find none. */
async function expectNoToast(page: Page): Promise<void> {
  await page.clock.runFor(100)
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
}

test.describe('background sync events (#2683, #6870) @sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await pauseClock(page)
  })

  test('a sync that changed blocks moves "last synced" and raises no toast', async ({ page }) => {
    await expect(page.getByTestId('last-synced')).toHaveText('Never synced')

    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 2,
      ops_sent: 0,
      changed_blocks: 2,
    })

    await expect(page.getByTestId('last-synced')).toHaveText('Last synced just now')
    await expectNoToast(page)
  })

  test('a failed background sync shows on the Sync button, not in a toast', async ({ page }) => {
    const state = syncButton(page).getByTestId('sync-state')
    await expect(state).toHaveAttribute('data-sync-state', 'idle')

    await emitMockEvent(page, 'sync:error', {
      type: 'error',
      remote_device_id: 'device-b',
      message: 'Connection refused',
    })

    await expect(state).toHaveAttribute('data-sync-state', 'error')
    await expectNoToast(page)
  })
})

/**
 * Pair one device in the mock and return its id: `confirm_pairing` arms a
 * reveal, and the peer appears on the third `list_peer_refs` read after it.
 */
async function pairOneDevice(page: Page): Promise<string> {
  const peerId = await page.evaluate(async () => {
    const invoke = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__.invoke
    await invoke('confirm_pairing', { passphrase: 'alpha bravo charlie delta' })
    let peers: Array<{ peer_id: string }> = []
    for (let read = 0; read < 3; read++) {
      peers = (await invoke('list_peer_refs')) as Array<{ peer_id: string }>
    }
    return peers[0]?.peer_id
  })
  expect(peerId, 'the mock paired a device').toBeTruthy()
  return peerId as string
}

// #6523 — what the sync status says when sync stops or waits, on the device
// that reads the backend's coded error.
test.describe('sync says why it waits or stops (#6523) @sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('an away device reads as waiting, with no toast and no error', async ({ page }) => {
    const peerId = await pairOneDevice(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Sync & devices')
    await expect(page.getByText('Paired Device').first()).toBeVisible()
    await pauseClock(page)

    await emitMockEvent(page, 'sync:error', {
      type: 'error',
      remote_device_id: peerId,
      message:
        'Waiting for the peer: it did not answer, and it is not announcing itself on the network',
      code: 'peer_away',
    })

    await expect(page.getByTestId('sync-panel-waiting')).toHaveText('Waiting for Paired Device')
    await expect(page.getByText('Waiting', { exact: true })).toBeVisible()
    await expect(
      page.getByRole('button', { name: 'Sync', exact: true }),
    ).toHaveAccessibleDescription('Waiting for Paired Device')
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expectNoToast(page)
    await page.screenshot({ path: test.info().outputPath('waiting-for-device.png') })
  })

  // #5728 — a paired device on another engine format (a 0.18 device meeting a
  // 0.19 one). The backend codes the error; the Sync & devices card says, in
  // the user's language, which device to update, and names it.
  test('a version mismatch names the device to update', async ({ page }) => {
    const peerId = await pairOneDevice(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Sync & devices')
    await expect(page.getByText('Paired Device').first()).toBeVisible()
    await pauseClock(page)

    await emitMockEvent(page, 'sync:error', {
      type: 'error',
      remote_device_id: peerId,
      message: 'peer engine format v3 incompatible with local v4',
      code: 'engine_format_mismatch',
      peer_is_older: true,
    })

    const sentence =
      'Paired Device runs an older version of Agaric. Update Agaric on Paired Device, then sync again.'
    await expect(page.getByRole('alert').getByText(sentence, { exact: true })).toBeVisible()
    // A background session's failure: the card and the Sync button say it.
    await expect(syncButton(page)).toHaveAccessibleDescription(
      `Sync failed: ${sentence} Never synced`,
    )
    await expectNoToast(page)
    await expect(page.getByText('peer engine format v3')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('version-mismatch.png') })
  })
})
