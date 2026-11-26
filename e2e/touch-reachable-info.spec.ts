import { devices, type Locator, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activePopover,
  expect,
  expect44,
  ipc,
  navigateMobile,
  navigateToView,
  openPage,
  openPageMobile,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * What a hover alone revealed is reachable on touch (#7040 M10), and a window
 * the app lays out as a phone gets the phone's CSS too (#7040 M3).
 *
 * - The palette's Recent pages bookmark toggle (`hover-reveal`) shows at rest on
 *   a coarse pointer, and only on hover or keyboard focus on a fine one.
 * - "Blocked by …" and a missing footnote's explanation open on a tap
 *   (`InfoPopover`), where a tooltip never opened.
 * - From 640 to 767 px `usePhoneLayout` is already true, so a Settings section
 *   card drops its box and the type scale steps down there as on a phone.
 */

const FIX_LOGIN_BUG = SEED_IDS.BLOCK_PROJ_2
const SHIP_RELEASE = SEED_IDS.BLOCK_PROJ_1

function recentBookmarkToggle(page: Page, title: string): Locator {
  return page
    .getByTestId('palette-recents-group')
    .getByRole('button', { name: `Bookmark ${title}`, exact: true })
}

function recentRow(page: Page, pageId: string): Locator {
  return page.getByTestId(`palette-recent-${pageId}`)
}

const pixel7 = devices['Pixel 7']

test.describe('on a phone @mobile @search @pages @journal @editor', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    hasTouch: pixel7.hasTouch,
    isMobile: pixel7.isMobile,
    deviceScaleFactor: pixel7.deviceScaleFactor,
    userAgent: pixel7.userAgent,
  })

  async function openSearchSheetRecents(page: Page): Promise<void> {
    await page.getByTestId('search-sheet-trigger').click()
    const sheet = page.getByTestId('search-sheet')
    await expect(sheet).toBeVisible()
    await sheet.evaluate((el) => Promise.all(el.getAnimations().map((slide) => slide.finished)))
    await page.getByTestId('search-sheet-segment-all-pages').click()
    await expect(page.getByTestId('palette-recents-group')).toBeVisible()
  }

  test('the Recent pages bookmark toggle shows at rest, and a tap bookmarks the page', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPageMobile(page, 'Quick Notes')
    await openSearchSheetRecents(page)

    const toggle = recentBookmarkToggle(page, 'Quick Notes')
    await expect(toggle).toHaveCSS('opacity', '1')
    await expect44(toggle, 'Recent pages bookmark toggle')
    await toggle.tap()
    await expect(recentRow(page, SEED_IDS.PAGE_QUICK_NOTES)).toHaveAttribute(
      'data-bookmarked',
      'true',
    )

    // Re-queried: the sheet reopens on the bookmark the tap wrote.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('search-sheet')).toHaveCount(0)
    await openSearchSheetRecents(page)
    await expect(recentRow(page, SEED_IDS.PAGE_QUICK_NOTES)).toHaveAttribute(
      'data-bookmarked',
      'true',
    )
  })

  test('a tap on a blocked task’s indicator says what blocks it', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'set_property', {
      blockId: FIX_LOGIN_BUG,
      key: 'blocked_by',
      value: { value_ref: SHIP_RELEASE },
    })
    await navigateMobile(page, 'Tasks')

    const row = page.getByTestId('agenda-results-item').filter({ hasText: 'Fix login bug' })
    const indicator = row.getByRole('button', { name: 'Blocked by: Ship v2.0 release' })
    await indicator.tap()
    await expect(activePopover(page)).toHaveText('Blocked by: Ship v2.0 release')
    // The tap opened the explanation, not the task's page.
    await expect(row).toBeVisible()
  })

  test('a tap on a footnote nothing defines says so', async ({ page }) => {
    await waitForBoot(page)
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: 'A claim[^source]',
      parentId: SEED_IDS.PAGE_QUICK_NOTES,
      index: null,
      scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
      blockId: null,
    })
    await openPageMobile(page, 'Quick Notes')

    const missing = page.getByRole('button', {
      name: '1 No block on this page defines this footnote',
    })
    await missing.tap()
    await expect(activePopover(page)).toHaveText('No block on this page defines this footnote')
    // The tap opened the explanation, not the block's editor.
    await expect(page.locator('[data-testid="block-editor"] [contenteditable="true"]')).toHaveCount(
      0,
    )
  })
})

test.describe('on a desktop @search', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the Recent pages bookmark toggle hides at rest and shows on hover and on keyboard focus', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('command-palette-input')).toBeFocused()
    const toggle = recentBookmarkToggle(page, 'Getting Started')

    await expect(toggle).toHaveCSS('opacity', '0')
    await recentRow(page, SEED_IDS.PAGE_GETTING_STARTED).hover()
    await expect(toggle).toHaveCSS('opacity', '1')
    await page.mouse.move(0, 0)
    await expect(toggle).toHaveCSS('opacity', '0')

    // Tab walks the palette's action panel and wraps to the input, then the toggle.
    for (
      let i = 0;
      i < 12 && !(await toggle.evaluate((el) => el === document.activeElement));
      i++
    ) {
      await page.keyboard.press('Tab')
    }
    await expect(toggle).toBeFocused()
    await expect(toggle).toHaveCSS('opacity', '1')
  })
})

/** General's first section card, which drops its box where the app is laid out as a phone. */
async function firstSettingsCard(page: Page): Promise<Locator> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'General')
  return page.locator('[data-slot="card"]').first()
}

async function pageTitleAfterOpening(page: Page, title: string): Promise<Locator> {
  await navigateToView(page, 'Pages')
  await page.getByText(title, { exact: true }).click()
  const heading = page.locator('[aria-label="Page title"]')
  await expect(heading).toHaveText(title)
  return heading
}

test.describe('in a 700 px window, laid out as a phone @settings @pages', () => {
  test.use({ viewport: { width: 700, height: 900 } })

  test('a Settings section card drops its box', async ({ page }) => {
    await waitForBoot(page)
    const card = await firstSettingsCard(page)
    await expect(card).toHaveCSS('border-top-width', '0px')
    await expect(card).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  })

  test('a page title takes the phone’s type scale', async ({ page }) => {
    await waitForBoot(page)
    const heading = await pageTitleAfterOpening(page, 'Getting Started')
    await expect(heading).toHaveCSS('font-size', '24px')
  })
})

test.describe('in a 1440 px window @settings @pages', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('a Settings section card keeps its box and a page title the desktop scale', async ({
    page,
  }) => {
    await waitForBoot(page)
    const card = await firstSettingsCard(page)
    await expect(card).toHaveCSS('border-top-width', '1px')
    const heading = await pageTitleAfterOpening(page, 'Getting Started')
    await expect(heading).toHaveCSS('font-size', '30px')
  })
})
