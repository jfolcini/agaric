/**
 * #6057 — Settings › Sync & devices lists the sync deltas the boot replay moved
 * to quarantine. No command creates one, so the spec seeds the mock through
 * `window.__addMockQuarantinedSlot`. Nothing is paired, which is the case
 * `SyncStatusCard` hides in.
 */

import type { Page } from '@playwright/test'

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

interface QuarantineWindow {
  __addMockQuarantinedSlot: (fields: Record<string, unknown>) => unknown
}

const HOUR = 60 * 60 * 1000

async function seedQuarantinedSlot(page: Page): Promise<void> {
  await page.evaluate((hour) => {
    ;(window as unknown as QuarantineWindow).__addMockQuarantinedSlot({
      space_id: 'SPACE_PERSONAL',
      byte_len: 2048,
      last_reason: 'replay failed: truncated blob',
      first_seen_at_ms: Date.now() - 2 * hour,
    })
  }, HOUR)
}

async function openSyncSettings(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Sync & devices')
  await expect(page.getByTestId('settings-panel-sync')).toBeVisible()
}

async function expectQuarantinedRow(page: Page): Promise<void> {
  const card = page.getByRole('region', { name: '1 sync change could not be applied' })
  await expect(card).toBeVisible()
  const row = card.getByRole('listitem')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Personal')
  await expect(row).toContainText('First seen 2h ago · 2.0 KB')
  await expect(row).toContainText('replay failed: truncated blob')
}

test.describe('Quarantined sync changes @sync @settings', () => {
  test('are listed in Sync & devices and still there after navigating away and back', async ({
    page,
  }) => {
    await waitForBoot(page)
    await seedQuarantinedSlot(page)

    await openSyncSettings(page)
    await expectQuarantinedRow(page)

    await navigateToView(page, 'Journal')
    await openSyncSettings(page)
    await expectQuarantinedRow(page)
  })

  test('fit a 360 px wide screen without scrolling sideways', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 })
    await waitForBoot(page)
    await seedQuarantinedSlot(page)

    await openSyncSettings(page)
    await expectQuarantinedRow(page)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBe(0)
  })
})
