import { finishSyncSession } from './domain'
import {
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
 * E2E — the "last synced" time ages: after a sync, the sidebar Sync tooltip and
 * the Settings › Sync & devices card read "just now", and five minutes later
 * "5m ago". It runs here because the stale label came from the React Compiler
 * caching it on the timestamp, and vitest runs with the compiler off.
 *
 * The mock answers `start_sync` at once and reports nothing, so the spec plays
 * the backend's end of the session: its `sync:complete`, which records the
 * last-synced time, and the terminal update on the press's channel.
 */

test('the last synced time counts up in the sidebar and in Settings @sync', async ({ page }) => {
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

  await keepSyncChannels(page)
  await syncButton(page).click()
  await expect.poll(() => syncChannelCount(page)).toBeGreaterThan(0)
  await finishSyncSession(page)
  await expect(await syncTooltipLines(page)).toHaveText([
    'Sync all devices',
    'Last synced just now',
  ])
  await expect(cardLastSynced).toHaveText('just now')

  await page.clock.fastForward('05:00')
  await expect(await syncTooltipLines(page)).toHaveText(['Sync all devices', 'Last synced 5m ago'])
  await expect(cardLastSynced).toHaveText('5m ago')
})
