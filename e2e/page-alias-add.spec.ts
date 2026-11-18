import type { Locator, Page } from '@playwright/test'
import { devices } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, ipc, openPage, openPageMobile, reopenPage, test, waitForBoot } from './helpers'

/**
 * Page actions → Add alias leaves focus in the new-alias input, so the user
 * types at once. The input focuses itself as it mounts, and the closing menu
 * keeps a focus that is not on `<body>` instead of returning it to the kebab.
 * The vitest DOM does not run Radix's close-time focus, so this spec is the pin.
 */

const PAGE = 'Quick Notes'

function aliasInput(page: Page): Locator {
  return page.getByRole('textbox', { name: 'New alias input', exact: true })
}

function addAliasItem(page: Page): Locator {
  return page.getByRole('menuitem', { name: 'Add alias', exact: true })
}

function pageActions(page: Page): Locator {
  return page.getByRole('button', { name: 'Page actions', exact: true })
}

/** Type into whatever holds focus, then submit with Enter and see the badge. */
async function typeAndAdd(page: Page, alias: string): Promise<void> {
  const input = aliasInput(page)
  await expect(addAliasItem(page)).toHaveCount(0)
  await expect(input).toBeFocused()
  await page.keyboard.type(alias)
  await expect(input).toHaveValue(alias)
  await expect(input).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(input).toHaveValue('')
  await expect(page.locator('[data-slot="badge"]').filter({ hasText: alias })).toBeVisible()
}

test.describe('Page actions → Add alias @pages @mobile', () => {
  test('by mouse, focus lands in the new-alias input', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)

    await pageActions(page).click()
    await addAliasItem(page).click()

    await typeAndAdd(page, 'Inbox')
  })

  test('by keyboard, focus lands in the new-alias input', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)

    // Opening the page focuses the main content a frame later, and opening the
    // menu focuses its first item a frame later: a focus placed before either
    // is taken back, and the first would close the menu.
    await expect(page.locator('#main-content')).toBeFocused()
    await pageActions(page).focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Page actions', exact: true })
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    const item = addAliasItem(page)
    await item.focus()
    await expect(item).toBeFocused()
    await page.keyboard.press('Enter')

    await typeAndAdd(page, 'Inbox')
  })
})

test.describe('Page actions → Add alias on a 390 px phone @pages @mobile', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('by touch, focus lands in the new-alias input', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)

    await pageActions(page).tap()
    await addAliasItem(page).tap()

    await typeAndAdd(page, 'Inbox')
  })
})

/**
 * An alias edit is `add_page_alias` / `remove_page_alias` ops (#5387), so the page's Ctrl+Z
 * reverses it through the op log. The kept alias is the positive signal that the header's alias
 * list has loaded, so the undone one's absence is not read off a header that has not fetched yet.
 */
test('Ctrl+Z removes the alias just added, and the page keeps only the other one @pages @editor', async ({
  page,
}) => {
  await waitForBoot(page)
  await ipc(page, 'set_page_aliases', { pageId: SEED_IDS.PAGE_QUICK_NOTES, aliases: ['Kept'] })
  // The page's undo takes every op within `UNDO_GROUP_WINDOW_MS` (src/stores/undo.ts) of the
  // newest as one group, by backend time, so the kept alias's op must be older than that window
  // when the undone one is written; a second clears it.
  const keptAt = Date.now()
  await openPage(page, PAGE)
  const badge = (alias: string) => page.locator('[data-slot="badge"]').filter({ hasText: alias })
  await expect(badge('Kept')).toBeVisible()
  await expect.poll(() => Date.now() - keptAt).toBeGreaterThan(1_000)

  await pageActions(page).click()
  await addAliasItem(page).click()
  await typeAndAdd(page, 'Undone')
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  // Ctrl+Z reaches the page's undo only with no input and no block focused.
  await expect(aliasInput(page)).toHaveCount(0)
  await page.locator('body').press('Control+z')
  await expect(page.locator('[data-sonner-toast]').getByText('Undid alias')).toBeVisible()
  await expect(badge('Undone')).toHaveCount(0)
  await expect(badge('Kept')).toBeVisible()

  await reopenPage(page, PAGE)
  await expect(badge('Kept')).toBeVisible()
  await expect(badge('Undone')).toHaveCount(0)
})
