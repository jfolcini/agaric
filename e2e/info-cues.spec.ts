import { devices, type Page } from '@playwright/test'

import {
  expect,
  fingerTap,
  navigateToView,
  openPage,
  openPageMobile,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

// #6895 — an explanation the user needs sits behind an ⓘ that opens on a tap,
// and a history row's "3m ago" swaps to the exact time on a press. Both used to
// be hover tooltips, which a tap never opens.

const iPhone13 = devices['iPhone 13']
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

const TASK_CYCLE = 'Task cycle help'
const YEAR = /\b20\d\d\b/

/** One fresh op, so History has a row timed "just now". */
async function openHistoryWithARow(page: Page, phone = false): Promise<void> {
  await (phone ? openPageMobile : openPage)(page, 'Getting Started')
  await page.getByRole('button', { name: 'Add block' }).click()
  await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()
  await navigateToView(page, 'History')
  await expect(page.locator('[data-history-item]').first()).toBeVisible()
}

test.describe('info cues on a phone @mobile @settings @editor @pages', () => {
  test.use(PHONE)

  test('a tap on the ⓘ opens its explanation and a tap outside closes it @settings @editor', async ({
    page,
  }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')

    const trigger = page.getByRole('button', { name: TASK_CYCLE })
    // `fingerTap` presses the point where the box is, so it must be on screen.
    await trigger.scrollIntoViewIfNeeded()
    await fingerTap(page, trigger)
    const info = page.getByRole('dialog', { name: TASK_CYCLE })
    await expect(info).toContainText('TODO')

    await fingerTap(page, page.getByRole('heading', { name: 'Settings' }).first())
    await expect(info).toHaveCount(0)
  })

  test("a tap on a history row's time shows the exact time and leaves the row unselected @pages", async ({
    page,
  }) => {
    await waitForBoot(page)
    await openHistoryWithARow(page, true)

    const row = page.locator('[data-history-item]').first()
    const time = row.locator('.history-item-time')
    await expect(time).not.toHaveText(YEAR)

    await fingerTap(page, time)
    await expect(time).toHaveText(YEAR)
    await expect(row).toHaveAttribute('aria-selected', 'false')

    await fingerTap(page, time)
    await expect(time).not.toHaveText(YEAR)
  })
})

test.describe('info cues on desktop @settings @editor @pages', () => {
  test('Enter opens the ⓘ and Escape closes it, back on the ⓘ @settings @editor', async ({
    page,
  }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')

    const trigger = page.getByRole('button', { name: TASK_CYCLE })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const info = page.getByRole('dialog', { name: TASK_CYCLE })
    await expect(info).toContainText('TODO')

    await page.keyboard.press('Escape')
    await expect(info).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test("Enter on a history row's time swaps it without selecting the row @pages", async ({
    page,
  }) => {
    await waitForBoot(page)
    await openHistoryWithARow(page)

    const row = page.locator('[data-history-item]').first()
    const time = row.locator('.history-item-time')
    await time.focus()
    await page.keyboard.press('Enter')
    await expect(time).toHaveText(YEAR)
    await expect(row).toHaveAttribute('aria-selected', 'false')
  })
})
