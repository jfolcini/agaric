/**
 * The callout variant from both block menus: the block context menu (right-click,
 * long-press, keyboard) offers Turn into → Callout → its variants, and the
 * toolbar's Turn into → Callout lists them with no filter box. Each pick is
 * re-read after navigating away and back.
 */
import { devices } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import {
  activeMenu,
  expect,
  focusBlock,
  openPage,
  openPageMobile,
  reopenPage,
  saveBlock,
  test,
  touchLongPress,
  waitForBoot,
} from './helpers'

const PAGE = 'Getting Started'

async function firstBlockId(page: Page): Promise<string> {
  const id = await page
    .locator('[data-testid="sortable-block"]')
    .first()
    .getAttribute('data-block-id')
  if (!id) throw new Error('the first block has no data-block-id')
  return id
}

function calloutOf(page: Page, blockId: string): Locator {
  return page.locator(
    `[data-testid="sortable-block"][data-block-id="${blockId}"] [data-testid="callout-block"]`,
  )
}

test.describe('Block context menu: callout variant @editor @mobile', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('right-click Turn into → Callout → Warning persists a warning callout', async ({ page }) => {
    const id = await firstBlockId(page)
    await page
      .locator(`[data-testid="block-static"][data-block-id="${id}"]`)
      .click({ button: 'right' })
    const menu = activeMenu(page)
    await menu.getByRole('menuitem', { name: /Turn into/ }).click()
    await menu.getByRole('menuitem', { name: 'Callout', exact: true }).click()
    const variants = menu.getByRole('group', { name: 'Callout' })
    await expect(variants.getByRole('menuitem')).toHaveText([
      'Info',
      'Warning',
      'Tip',
      'Error',
      'Note',
    ])
    await expect(variants.getByRole('menuitem', { name: 'Note' })).toBeInViewport()
    await variants.getByRole('menuitem', { name: 'Warning' }).click()

    await expect(page.getByRole('menu', { name: 'Block actions' })).toHaveCount(0)
    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'warning')
    await reopenPage(page, PAGE)
    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'warning')
    await expect(calloutOf(page, id)).toContainText('Welcome to Agaric!')
  })

  test('the keyboard reaches a variant: focus stays on each toggle it opens', async ({ page }) => {
    const id = await firstBlockId(page)
    await page
      .locator(`[data-testid="block-static"][data-block-id="${id}"]`)
      .click({ button: 'right' })
    const menu = activeMenu(page)
    const turnInto = menu.getByRole('menuitem', { name: /Turn into/ })
    const callout = menu.getByRole('menuitem', { name: 'Callout', exact: true })

    async function arrowDownTo(target: Locator): Promise<void> {
      for (let i = 0; i < 30; i++) {
        if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return
        await page.keyboard.press('ArrowDown')
      }
      await expect(target).toBeFocused()
    }

    await arrowDownTo(turnInto)
    await page.keyboard.press('Enter')
    await expect(turnInto).toHaveAttribute('aria-expanded', 'true')
    await expect(turnInto).toBeFocused()
    await arrowDownTo(callout)
    await page.keyboard.press('Enter')
    await expect(callout).toHaveAttribute('aria-expanded', 'true')
    await expect(callout).toBeFocused()
    for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Error' })).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'error')
    await reopenPage(page, PAGE)
    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'error')
  })

  test('a callout re-picks its variant from the same menu', async ({ page }) => {
    const id = await firstBlockId(page)
    const row = page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
    for (const [label, type] of [
      ['Note', 'note'],
      ['Tip', 'tip'],
    ] as const) {
      await row.locator('[data-testid="block-static"]').click({ button: 'right' })
      const menu = activeMenu(page)
      await menu.getByRole('menuitem', { name: /Turn into/ }).click()
      await menu.getByRole('menuitem', { name: 'Callout', exact: true }).click()
      await menu.getByRole('menuitem', { name: label, exact: true }).click()
      await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', type)
    }
    await reopenPage(page, PAGE)
    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'tip')
  })
})

test.describe('Long-press menu: callout variant (iPhone viewport) @editor @mobile', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('long-press Turn into → Callout → Tip persists a tip callout', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)
    const id = await firstBlockId(page)

    await touchLongPress(page, `[data-testid="block-static"][data-block-id="${id}"]`)
    const menu = activeMenu(page)
    await menu.getByRole('menuitem', { name: /Turn into/ }).tap()
    await menu.getByRole('menuitem', { name: 'Callout', exact: true }).tap()
    const tip = menu.getByRole('group', { name: 'Callout' }).getByRole('menuitem', { name: 'Tip' })
    await expect(tip).toBeInViewport()
    await tip.tap()

    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'tip')
    await openPageMobile(page, 'Quick Notes')
    await openPageMobile(page, PAGE)
    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'tip')
  })
})

test.describe('Toolbar Turn into: callout variant @editor @mobile', () => {
  test('lists the variants with no search box, and still turns the block', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    const id = await firstBlockId(page)
    await focusBlock(page)

    await page
      .locator('[data-testid="block-editor"]')
      .getByRole('button', { name: 'Turn into', exact: true })
      .click()
    await page.getByRole('menuitem', { name: 'Callout', exact: true }).click()
    const panel = page.getByRole('dialog', { name: 'Callout' })
    await expect(panel.getByRole('button')).toHaveText(['Info', 'Warning', 'Tip', 'Error', 'Note'])
    await expect(panel.getByRole('textbox')).toHaveCount(0)
    await panel.getByRole('button', { name: 'Tip' }).click()
    await saveBlock(page)

    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'tip')
    await reopenPage(page, PAGE)
    await expect(calloutOf(page, id)).toHaveAttribute('data-callout-type', 'tip')
  })
})
