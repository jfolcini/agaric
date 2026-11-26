/**
 * #6895 — the formatting toolbar's icon-only buttons name themselves on a
 * phone: a press-and-hold shows the tooltip, with the name alone, as a phone
 * has no keyboard for the shortcut. With a mouse, hover shows the name and the
 * shortcut. The bar sits outside the block rows, so the hold is the button's
 * and opens no block menu. A finger acts on the release of a short tap, and
 * the release of a hold does nothing: learning a name never applies it.
 */

import { devices } from '@playwright/test'

import {
  centerOf,
  expect,
  fingerTap,
  focusBlock,
  selectEditorRange,
  test,
  waitForBoot,
  withTouch,
} from './helpers'

const iPhone13 = devices['iPhone 13']
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

// `useLongPress` opens the tooltip after 500 ms.
const HOLD_MS = 700

test.describe('toolbar labels on a phone @mobile @editor', () => {
  test.use(PHONE)

  test('a press-and-hold on a toolbar button shows its name and no shortcut @mobile @editor', async ({
    page,
  }) => {
    await waitForBoot(page)
    await focusBlock(page, 0)
    const button = page.getByTestId('formatting-toolbar').getByRole('button', { name: 'New line' })
    await expect(button).toBeVisible()

    const point = await centerOf(button, 'New line')
    const tip = page.locator('[data-slot="tooltip-content"]')
    await withTouch(page, async (touch) => {
      await touch.start(point.x, point.y)
      await page.waitForTimeout(HOLD_MS)
      await expect(tip).toBeVisible()
      await expect(tip).toContainText('New line')
      await expect(tip).not.toContainText('Shift')
      await touch.end()
    })
    await expect(page.getByTestId('block-context-menu')).toHaveCount(0)
    // The hold only named the button: no line break went in.
    await expect(page.locator('.ProseMirror br')).toHaveCount(0)
  })

  test('a short tap applies the button to the selection, which stays selected @mobile @editor', async ({
    page,
  }) => {
    await waitForBoot(page)
    const editor = await focusBlock(page, 0)
    await page.keyboard.press('Control+a')
    await page.keyboard.type('the word here')
    await selectEditorRange(page, 4, 8)
    const selected = 'word'
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)

    // A phone keeps the marks in the toolbar's Format menu.
    await fingerTap(
      page,
      page.getByTestId('formatting-toolbar').getByRole('button', { name: 'Format' }),
    )
    await fingerTap(page, page.getByRole('button', { name: 'Bold', exact: true }))

    await expect(editor.locator('strong')).toHaveText(selected)
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe(selected)
  })
})

test.describe('toolbar labels on desktop @editor', () => {
  test('hover on a toolbar button shows its name and its shortcut @editor', async ({ page }) => {
    await waitForBoot(page)
    await focusBlock(page, 0)
    const button = page
      .getByTestId('formatting-toolbar')
      .getByRole('button', { name: 'Properties', exact: true })

    await button.hover()
    const tip = page.locator('[data-slot="tooltip-content"]')
    await expect(tip).toContainText('Block properties')
    await expect(tip.locator('kbd')).toHaveText('Ctrl+Shift+P')
  })
})
