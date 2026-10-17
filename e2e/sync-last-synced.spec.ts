import type { Locator, Page } from '@playwright/test'

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * E2E — the "last synced" time ages: after a sync, the sidebar Sync tooltip and
 * the Settings › Sync & devices card read "just now", and five minutes later
 * "5m ago". It runs here because the stale label came from the React Compiler
 * caching it on the timestamp, and vitest runs with the compiler off.
 *
 * The mock answers `start_sync` at once and reports nothing, so the spec emits
 * the `sync:complete` the backend sends when a session finishes; that event is
 * what records the last-synced time.
 */

interface MockWindow {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: unknown) => Promise<unknown>
  }
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

/** Pair one device as the mock completes a pairing: it appears a few reads after the confirm. */
async function pairOnePeer(page: Page): Promise<void> {
  const peerCount = () =>
    page.evaluate(async () => {
      const { invoke } = (window as unknown as MockWindow).__TAURI_INTERNALS__
      return ((await invoke('list_peer_refs')) as unknown[]).length
    })
  await page.evaluate(() =>
    (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke('confirm_pairing', {
      passphrase: 'alpha bravo charlie delta',
      scannedPeer: null,
    }),
  )
  await expect.poll(peerCount).toBe(1)
}

/** Its name changes with the network, so find it by the status dot it carries. */
function syncButton(page: Page): Locator {
  return page
    .locator('[data-sidebar="footer"]')
    .getByRole('button')
    .filter({ has: page.getByTestId('sync-button-status-dot') })
}

/** The Sync icon's tooltip lines (state, then last synced), opened from the keyboard. */
async function syncTooltipLines(page: Page): Promise<Locator> {
  const button = syncButton(page)
  await button.blur()
  await button.focus()
  return page.getByRole('tooltip').locator(':scope > div > span')
}

test('the last synced time counts up in the sidebar and in Settings', async ({ page }) => {
  await page.clock.install()
  await waitForBoot(page)
  await pairOnePeer(page)
  // The device list loads the peer into the store the status card reads.
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  const cardLastSynced = page
    .getByTestId('settings-panel-sync')
    .locator('[data-slot="metric-card"]')
    .filter({ has: page.getByRole('term').filter({ hasText: /^Last synced$/ }) })
    .getByRole('definition')
  await expect(cardLastSynced).toHaveText('--')
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)

  await syncButton(page).click()
  await page.evaluate(
    (payload) => (window as unknown as MockWindow).__emitMockEvent?.('sync:complete', payload),
    {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 1,
      ops_sent: 1,
      changed_blocks: 0,
    },
  )
  await expect(await syncTooltipLines(page)).toHaveText([
    'Sync all devices',
    'Last synced just now',
  ])
  await expect(cardLastSynced).toHaveText('just now')

  await page.clock.fastForward('05:00')
  await expect(await syncTooltipLines(page)).toHaveText(['Sync all devices', 'Last synced 5m ago'])
  await expect(cardLastSynced).toHaveText('5m ago')
})
