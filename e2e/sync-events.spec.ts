import { expect, navigateToView, openSettingsTab, test } from './helpers'

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

    await expect(page.getByText('Sync failed: Connection refused')).toBeVisible()
  })

  // #5728 — a paired device on another engine format (a 0.18 device meeting a
  // 0.19 one). The backend codes the error; the Sync & devices card says, in
  // the user's language, to update both, and names the device.
  test('a version mismatch names the device and says to update both', async ({ page }) => {
    // Pair one device in the mock: `confirm_pairing` arms a reveal, and the
    // peer appears on the third `list_peer_refs` read after it.
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
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Sync & devices')
    await expect(page.getByText('Paired Device').first()).toBeVisible()

    await emitMockEvent(page, 'sync:error', {
      type: 'error',
      remote_device_id: peerId,
      message: 'peer engine format v3 incompatible with local v4',
      code: 'engine_format_mismatch',
    })

    const sentence =
      'This device and Paired Device run different versions of Agaric. Update both to the latest version, then sync again.'
    await expect(page.getByRole('alert').getByText(sentence, { exact: true })).toBeVisible()
    await expect(page.getByText(`Sync failed: ${sentence}`)).toBeVisible()
    await expect(page.getByText('peer engine format v3')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('version-mismatch.png') })
  })
})
