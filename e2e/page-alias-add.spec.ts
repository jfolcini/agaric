import type { Locator, Page } from '@playwright/test'
import { devices } from '@playwright/test'

import { expect, openPage, openPageMobile, test, waitForBoot } from './helpers'

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
