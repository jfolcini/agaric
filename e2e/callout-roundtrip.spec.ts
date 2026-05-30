/**
 * E2E regression for #258 — callouts must keep their type through the editor
 * round-trip. Before the fix, `/callout` produced a plain blockquote (the
 * editor's stock Blockquote dropped `calloutType`), so no `callout-block`
 * rendered after save.
 */
import { expect, test } from '@playwright/test'

import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

test.describe('Callout round-trip (#258)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('/callout renders a callout-block after save (type survives round-trip)', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)
    await page.keyboard.press('Control+a')
    await editor.type('important note')
    // trigger the slash menu: a trailing "/callout" query, then select it
    await editor.type(' /callout')
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)

    await saveBlock(page)
    await page.waitForTimeout(300)

    const callout = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="callout-block"]')
    await expect(callout).toBeVisible()
    await expect(callout).toContainText('important note')
  })
})
