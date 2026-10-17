import type { Locator, Page } from '@playwright/test'

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * E2E — sync happy paths the mock can show failing (#5739): the sidebar Sync
 * icon's states with its "last synced" tooltip, and the internet fallback
 * switch in Settings › Sync & devices.
 *
 * The icon reads the sync store. `useSyncTrigger`'s own run writes syncing
 * (there is no `sync:started` event) and, when it finds no network, offline;
 * `sync:complete` writes idle and the last-synced time; `sync:error` writes
 * failed. The mock answers `start_sync` at once, so the spec holds it open,
 * as a slow peer would, to see the syncing state.
 */

interface MockWindow {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
  }
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
  __releaseStartSync?: () => void
}

function emitMockEvent(page: Page, event: string, payload: unknown): Promise<void> {
  return page.evaluate(
    ({ event: evt, payload: data }) =>
      (window as unknown as MockWindow).__emitMockEvent?.(evt, data),
    { event, payload },
  )
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

/** Hold the next `start_sync` open until `releaseStartSync`. */
function holdNextStartSync(page: Page): Promise<void> {
  return page.evaluate(() => {
    const w = window as unknown as MockWindow
    const invoke = w.__TAURI_INTERNALS__.invoke
    w.__TAURI_INTERNALS__.invoke = (cmd, args, opts) => {
      if (cmd !== 'start_sync') return invoke(cmd, args, opts)
      w.__TAURI_INTERNALS__.invoke = invoke
      return new Promise((resolve) => {
        w.__releaseStartSync = () => resolve(invoke(cmd, args, opts))
      })
    }
  })
}

function releaseStartSync(page: Page): Promise<void> {
  return page.evaluate(() => (window as unknown as MockWindow).__releaseStartSync?.())
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

test('the sidebar Sync icon shows idle, syncing, failed and offline, and when it last synced', async ({
  page,
}) => {
  await page.clock.install()
  await waitForBoot(page)
  await pairOnePeer(page)
  // The device list loads the peer into the store the icon's dot reads.
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  await expect(page.getByTestId('settings-panel-sync').locator('.device-peer-name')).toHaveText(
    'Paired Device',
  )
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)

  const button = syncButton(page)
  const dot = page.getByTestId('sync-button-status-dot')
  await expect(button).toHaveAccessibleName('Sync')
  await expect(dot).toHaveAttribute('data-sync-state', 'idle')
  await expect(dot).toContainClass('bg-sync-idle')
  await expect(await syncTooltipLines(page)).toHaveText(['Sync all devices', 'Never synced'])

  await holdNextStartSync(page)
  await button.click()
  await expect(dot).toHaveAttribute('data-sync-state', 'syncing')
  await expect(dot).toContainClass('bg-sync-active')
  await expect(button.locator('svg')).toContainClass('animate-spin')
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await expect(await syncTooltipLines(page)).toHaveText(['Syncing...', 'Never synced'])

  // The peer answers, and the backend reports the finished session.
  await releaseStartSync(page)
  await emitMockEvent(page, 'sync:complete', {
    type: 'complete',
    remote_device_id: 'device-b',
    ops_received: 1,
    ops_sent: 1,
    changed_blocks: 0,
  })
  await expect(dot).toHaveAttribute('data-sync-state', 'idle')
  await expect(button).toHaveAttribute('aria-disabled', 'false')
  await expect(await syncTooltipLines(page)).toHaveText([
    'Sync all devices',
    'Last synced just now',
  ])

  await emitMockEvent(page, 'sync:error', {
    type: 'error',
    remote_device_id: 'device-b',
    message: 'Connection refused',
  })
  await expect(dot).toHaveAttribute('data-sync-state', 'error')
  await expect(dot).toContainClass('bg-destructive')

  await page.context().setOffline(true)
  await expect(button).toHaveAccessibleName('Offline')
  await expect(await syncTooltipLines(page)).toHaveText(['Offline', 'Last synced just now'])
  // The next scheduled run finds no network and puts the dot in step.
  await page.clock.fastForward('01:00')
  await expect(dot).toHaveAttribute('data-sync-state', 'offline')
  await expect(dot).toContainClass('bg-muted-foreground')
})

function relayEnabled(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const { invoke } = (window as unknown as MockWindow).__TAURI_INTERNALS__
    return ((await invoke('get_sync_relay_settings')) as { enabled: boolean }).enabled
  })
}

test('the internet fallback switch starts off, turns on for the next launch, and stays on', async ({
  page,
}) => {
  await waitForBoot(page)
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  const fallback = page.getByRole('switch', {
    name: 'Local network, with an internet fallback',
    exact: true,
  })
  await expect(fallback).not.toBeChecked()

  await fallback.click()
  await expect(fallback).toBeChecked()
  await expect(fallback).toHaveAccessibleDescription(
    /it takes effect the next time Agaric starts\.$/,
  )
  await expect.poll(() => relayEnabled(page)).toBe(true)

  await navigateToView(page, 'Journal')
  await expect(page.getByTestId('settings-panel-sync')).toHaveCount(0)
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  await expect(fallback).toBeChecked()
})
