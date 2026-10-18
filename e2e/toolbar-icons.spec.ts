/**
 * The editing toolbar's and the selection bubble's icons render at 16 px, the
 * `icon-xs` Button's icon size. At 12 px lucide's strokes blur at 1x.
 */

import { expect, focusBlock, openPage, selectEditorRange, test, waitForBoot } from './helpers'

test('toolbar and selection bubble icons render at 16 px @editor', async ({ page }) => {
  // The bubble's zoom-in entry animation scales its icons until it settles.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await focusBlock(page)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('hello world')
  await selectEditorRange(page, 6, 11)
  await expect(page.getByTestId('formatting-toolbar')).toBeVisible()
  await expect(page.getByTestId('selection-bubble-menu')).toBeVisible()

  const iconSizes = (testId: string) =>
    page
      .getByTestId(testId)
      .locator('button svg')
      .evaluateAll((icons) =>
        icons
          // The overflow sentinel's duplicates are invisible measuring copies.
          .filter((icon) => icon.checkVisibility({ visibilityProperty: true }))
          .map((icon) => {
            const { width, height } = icon.getBoundingClientRect()
            return `${icon.closest('button')?.getAttribute('aria-label')}: ${width}x${height}`
          }),
      )

  const toolbar = await iconSizes('formatting-toolbar')
  const bubble = await iconSizes('selection-bubble-menu')
  expect(bubble).toHaveLength(7)
  expect(toolbar).toHaveLength(17)
  for (const sizes of [toolbar, bubble]) {
    expect(sizes).toEqual(sizes.map((s) => `${s.split(':')[0]}: 16x16`))
  }
})
