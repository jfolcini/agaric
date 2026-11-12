import type { Page } from '@playwright/test'

import { finishSyncSession } from './domain'
import {
  emitMockEvent,
  expect,
  keepSyncChannels,
  navigateToView,
  openSettingsTab,
  pairOnePeer,
  syncButton,
  syncChannelCount,
  syncTooltipLines,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E — sync happy paths the mock can show failing (#5739): the sidebar Sync
 * icon's states (no devices paired, idle, syncing, failed, offline) with its
 * "last synced" tooltip, and the internet fallback switch in Settings › Sync &
 * devices.
 *
 * The icon reads the sync store. A pressed Sync writes syncing (there is no
 * `sync:started` event) and, when it finds no network, offline;
 * `sync:complete` writes idle and the last-synced time; `sync:error` writes
 * failed. The mock answers `start_sync` at once, so the spec holds it open,
 * as a slow peer would, to see the syncing state.
 *
 * `start_sync` only queues a session (#6551): a press is answered by the
 * terminal update on the channel it opened, which the mock never sends, so
 * the spec keeps that channel and plays the backend's side.
 */

interface MockWindow {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>
  }
  __releaseStartSync?: () => void
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

test('the sidebar Sync icon shows no devices paired, idle, syncing, failed and offline, and when it last synced @sync', async ({
  page,
}) => {
  await page.clock.install()
  await waitForBoot(page)
  const button = syncButton(page)
  const dot = page.getByTestId('sync-button-status-dot')
  // A fresh install has no paired device, and the button says so, not only the dot (#6528).
  await expect(dot).toContainClass('bg-status-pending-foreground')
  await expect(button).toHaveAccessibleDescription('No devices paired Never synced')
  await expect(await syncTooltipLines(page)).toHaveText(['No devices paired', 'Never synced'])
  await button.blur()

  await pairOnePeer(page)
  // The device list loads the peer into the store the icon's dot reads.
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  await expect(page.getByTestId('settings-panel-sync').locator('.device-peer-name')).toHaveText(
    'Paired Device',
  )
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)

  await expect(button).toHaveAccessibleName('Sync')
  await expect(dot).toHaveAttribute('data-sync-state', 'idle')
  await expect(dot).toContainClass('bg-sync-idle')
  await expect(await syncTooltipLines(page)).toHaveText(['Sync all devices', 'Never synced'])

  await keepSyncChannels(page)
  await holdNextStartSync(page)
  await button.click()
  await expect(dot).toHaveAttribute('data-sync-state', 'syncing')
  await expect(dot).toContainClass('bg-sync-active')
  await expect(button.locator('svg')).toContainClass('animate-spin')
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await expect(await syncTooltipLines(page)).toHaveText(['Syncing...', 'Never synced'])

  // The peer answers, and the backend reports the finished session.
  await releaseStartSync(page)
  await expect.poll(() => syncChannelCount(page)).toBeGreaterThan(0)
  await finishSyncSession(page)
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
  // The failure stays on the button after the toast, not only in the dot's hue (#6528).
  // Blurred, so the open tooltip does not join the description.
  await button.blur()
  await expect(button).toHaveAccessibleDescription(
    'Sync failed: Connection refused Last synced just now',
  )
  await expect(await syncTooltipLines(page)).toHaveText([
    'Sync failed: Connection refused',
    'Last synced just now',
  ])

  await page.context().setOffline(true)
  await expect(button).toHaveAccessibleName('Offline')
  await expect(await syncTooltipLines(page)).toHaveText(['Offline', 'Last synced just now'])
  // The next scheduled run finds no network and puts the dot in step.
  await page.clock.fastForward('01:00')
  await expect(dot).toHaveAttribute('data-sync-state', 'offline')
  await expect(dot).toContainClass('bg-muted-foreground')
})

test('a pressed Sync says "Sync complete" only once its session finished @sync', async ({
  page,
}) => {
  await page.clock.install()
  await waitForBoot(page)
  await pairOnePeer(page)
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  await expect(page.getByTestId('settings-panel-sync').locator('.device-peer-name')).toHaveText(
    'Paired Device',
  )
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
  const button = syncButton(page)
  const toasts = page.locator('[data-sonner-toast]')
  await keepSyncChannels(page)

  // The peer is switched off: the command returns, and no session ever reports back.
  // Sonner renders on a timer of its own, so the paused clock is run after each step
  // that could raise a toast.
  await button.click()
  await expect.poll(() => syncChannelCount(page)).toBeGreaterThan(0)
  await page.clock.runFor(1000)
  await expect(toasts.getByText('Sync complete', { exact: true })).toHaveCount(0)
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await page.clock.fastForward('01:00')
  await page.clock.runFor(100)
  await expect(toasts.getByText(/^Sync failed for device /)).toBeVisible()
  await expect(button).toHaveAttribute('aria-disabled', 'false')
  await expect(toasts.getByText('Sync complete', { exact: true })).toHaveCount(0)

  // The peer is back: the next press's session finishes, and only that is a success.
  const channelsBefore = await syncChannelCount(page)
  await button.click()
  await expect.poll(() => syncChannelCount(page)).toBeGreaterThan(channelsBefore)
  await finishSyncSession(page)
  await page.clock.runFor(100)
  await expect(toasts.getByText('Sync complete', { exact: true })).toBeVisible()
  await expect(button).toHaveAttribute('aria-disabled', 'false')
})

function relayEnabled(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const { invoke } = (window as unknown as MockWindow).__TAURI_INTERNALS__
    return ((await invoke('get_sync_relay_settings')) as { enabled: boolean }).enabled
  })
}

test('the internet fallback switch starts off, turns on for the next launch, and stays on @sync', async ({
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
