import type { Page } from '@playwright/test'

import { expect, navigateToView, openSettingsTab, pairOnePeer, test, waitForBoot } from './helpers'

/**
 * E2E — a device row shows its running session's progress (#5842).
 *
 * The backend streams progress over the channel `start_sync` registers, after
 * the command itself has returned. The mock answers `start_sync` and streams
 * nothing, so the spec keeps the channel the app passed and plays the
 * backend's side: op progress, the attachment exchange, its `complete` tick.
 */

interface ProgressChannel {
  onmessage?: (update: unknown) => void
}

interface MockWindow {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
  }
  __syncChannels?: ProgressChannel[]
}

/** Keep every progress channel `start_sync` is handed. */
function keepSyncChannels(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as MockWindow
    const invoke = w.__TAURI_INTERNALS__.invoke
    w.__syncChannels = []
    w.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => {
      if (cmd === 'start_sync') {
        w.__syncChannels?.push((args as { progress: ProgressChannel }).progress)
      }
      return invoke(cmd, args, opts)
    }
  })
}

/** Send one update down the channel the latest `start_sync` registered, as the backend would. */
function streamProgress(page: Page, update: unknown): Promise<void> {
  return page.evaluate((u) => {
    const channels = (window as unknown as MockWindow).__syncChannels ?? []
    channels.at(-1)?.onmessage?.(u)
  }, update)
}

test('a device row shows ops, then attachment bytes, while it syncs, and clears after @sync', async ({
  page,
}) => {
  await waitForBoot(page)
  await pairOnePeer(page)
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  const row = page.locator('.device-peer-item')
  await expect(row.locator('.device-peer-name')).toHaveText('Paired Device')

  await keepSyncChannels(page)
  await row.getByRole('button', { name: 'Sync now with device Paired Device' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as MockWindow).__syncChannels?.length))
    .toBeGreaterThan(0)

  const files = (phase: string, filesDone: number, bytesDone: number) => ({
    kind: 'files',
    phase,
    remote_device_id: 'device-b',
    files_done: filesDone,
    files_total: 2,
    bytes_done: bytesDone,
    bytes_total: 2_097_152,
  })

  await streamProgress(page, {
    kind: 'sync',
    state: 'streaming',
    remote_device_id: 'device-b',
    ops_sent: 2,
    ops_received: 1,
  })
  await expect(row.getByText('Syncing: 2 messages sent, 1 received')).toBeVisible()

  await streamProgress(page, files('receiving', 1, 1_048_576))
  await expect(row.getByText('Receiving attachments: 1 of 2 files, 1.0 MB of 2.0 MB')).toBeVisible()
  const bar = row.getByRole('progressbar', { name: 'Attachment transfer with Paired Device' })
  await expect(bar).toHaveJSProperty('value', 1_048_576)
  await expect(bar).toHaveJSProperty('max', 2_097_152)

  await streamProgress(page, files('complete', 2, 2_097_152))
  await expect(row.locator('.device-peer-progress')).toHaveCount(0)
})
