/**
 * E2E — the Due panel's touch reschedule popover (#5441).
 *
 * The row's reschedule button only shows on coarse pointers, and the calendar
 * inside its popover is lazy-loaded on first open. A first tap must show the
 * calendar and a picked day must land on the block.
 */

import type { Page } from '@playwright/test'
import { devices } from '@playwright/test'

import { activePopover, expect, test, waitForBoot } from './helpers'

// SEED_IDS.BLOCK_PROJ_2 (src/lib/tauri-mock/seed.ts): "Fix login bug" on Projects, due
// today with no scheduled date, so a reschedule writes its due date.
const FIX_LOGIN_BUG = '0000000000000000000BLOCK14'

const iPhone13 = devices['iPhone 13']

async function dueDate(page: Page): Promise<string | null> {
  return page.evaluate(async (blockId) => {
    const invoke = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__.invoke
    return ((await invoke('get_block', { blockId })) as { due_date: string | null }).due_date
  }, FIX_LOGIN_BUG)
}

test.describe('Due panel reschedule popover (touch)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('the first tap opens the calendar and the picked day becomes the due date', async ({
    page,
  }) => {
    await waitForBoot(page)

    const row = page.getByTestId('due-panel-item').filter({ hasText: 'Fix login bug' })
    await row.getByTestId('reschedule-btn').tap()

    // Any in-month day other than today (the current due date) is a real change.
    const day = activePopover(page)
      .locator('[role="gridcell"]:not([data-outside]):not([data-today])')
      .first()
    await expect(day).toBeVisible()
    const picked = await day.getAttribute('data-day')
    expect(picked).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    await day.getByRole('button').tap()

    await expect.poll(() => dueDate(page)).toBe(picked)
  })
})
