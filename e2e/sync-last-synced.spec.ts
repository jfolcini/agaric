import {
  emitMockEvent,
  expect,
  navigateToView,
  openSettingsTab,
  pairOnePeer,
  syncButton,
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
 * The mock answers `start_sync` at once and reports nothing, so the spec emits
 * the `sync:complete` the backend sends when a session finishes; that event is
 * what records the last-synced time.
 */

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
  await emitMockEvent(page, 'sync:complete', {
    type: 'complete',
    remote_device_id: 'device-b',
    ops_received: 1,
    ops_sent: 1,
    changed_blocks: 0,
  })
  await expect(await syncTooltipLines(page)).toHaveText([
    'Sync all devices',
    'Last synced just now',
  ])
  await expect(cardLastSynced).toHaveText('just now')

  await page.clock.fastForward('05:00')
  await expect(await syncTooltipLines(page)).toHaveText(['Sync all devices', 'Last synced 5m ago'])
  await expect(cardLastSynced).toHaveText('5m ago')
})
