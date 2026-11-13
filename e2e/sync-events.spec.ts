import type { Page } from '@playwright/test'

import { emitMockEvent, expect, navigateToView, openSettingsTab, test } from './helpers'

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

test.describe('sync events (#2683) @sync', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('sync:complete toasts the CHANGED-BLOCK count, not the message count', async ({ page }) => {
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 2,
      ops_sent: 0,
      changed_blocks: 2,
    })

    await expect(page.getByText('Synced 2 changes from device')).toBeVisible()
  })

  // #4305 — the regression this whole change exists for, pinned end to end.
  // `ops_received` counts one inbound LoroSync message PER SPACE, sent whether
  // or not that space had a delta, so on a two-space vault it is 2 on every
  // tick of a perfectly idle pair. A user with two spaces got "Synced 2 changes
  // from device" once a minute, forever, having edited nothing.
  //
  // The payload below is exactly that shape: two messages arrived, zero blocks
  // changed. Under the old `ops_received > 0` gate this toasted; it must not.
  test('sync:complete is silent when messages arrived but nothing changed', async ({ page }) => {
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 2,
      ops_sent: 0,
      changed_blocks: 0,
    })

    await expect(page.getByText(/Synced \d+ changes? from device/)).not.toBeVisible()
  })

  // The other side of the gate: a whole-space snapshot catch-up genuinely
  // changed things but cannot enumerate them, so `changed_blocks` is absent.
  // Absent must be LOUD — a producer that forgets the field can never silence
  // a real sync.
  test('sync:complete with an unknown change count still toasts', async ({ page }) => {
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 2,
      ops_sent: 0,
    })

    await expect(page.getByText('Synced changes from device')).toBeVisible()
  })

  test('sync:complete with zero changed blocks shows no toast', async ({ page }) => {
    // A heartbeat sync that moved nothing stays silent. Post-#4305 the gate is
    // `changed_blocks === 0`, not `ops_received === 0`.
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 0,
      ops_sent: 0,
      changed_blocks: 0,
    })

    await expect(page.getByText(/Synced \d+ changes? from device/)).not.toBeVisible()
  })

  test('sync:error shows the failure toast with the backend message', async ({ page }) => {
    await emitMockEvent(page, 'sync:error', {
      type: 'error',
      remote_device_id: 'device-b',
      message: 'Connection refused',
    })

    await expect(
      page.locator('[data-sonner-toast]').getByText('Sync failed: Connection refused'),
    ).toBeVisible()
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
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('an away device reads as waiting, with no toast and no error', async ({ page }) => {
    const peerId = await pairOneDevice(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Sync & devices')
    await expect(page.getByText('Paired Device').first()).toBeVisible()

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
    await page.screenshot({ path: test.info().outputPath('waiting-for-device.png') })

    // A toast raised after the away event is on screen, so one the away event
    // raised would be too: the control is the only toast.
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: peerId,
      ops_received: 1,
      ops_sent: 0,
      changed_blocks: 1,
    })
    await expect(page.locator('[data-sonner-toast]')).toHaveText(['Synced 1 change from device'])
  })

  // #5728 — a paired device on another engine format (a 0.18 device meeting a
  // 0.19 one). The backend codes the error; the Sync & devices card says, in
  // the user's language, which device to update, and names it.
  test('a version mismatch names the device to update', async ({ page }) => {
    const peerId = await pairOneDevice(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Sync & devices')
    await expect(page.getByText('Paired Device').first()).toBeVisible()

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
    await expect(
      page.locator('[data-sonner-toast]').getByText(`Sync failed: ${sentence}`),
    ).toBeVisible()
    await expect(page.getByText('peer engine format v3')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('version-mismatch.png') })
  })
})
