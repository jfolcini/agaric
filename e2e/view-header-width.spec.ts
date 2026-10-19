/**
 * #5992 — the view header (a page's title, its Blocks | Page switch, bookmark
 * and kebab) stays on a mouse window of any width: below `md` it stays pinned
 * above the scroller instead of scrolling away as on a touch phone, and it
 * survives the window crossing `md`. On a touch device crossing `md` swaps
 * the header between its two slots, and the header survives that too.
 */

import { devices, type Page } from '@playwright/test'

import { expect, openPage, test, waitForBoot } from './helpers'

interface MockWindow {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
}

const TITLE = 'Long page'

/** A page long enough to scroll at 800 px. */
async function seedLongPage(page: Page): Promise<void> {
  await page.evaluate(async (title) => {
    const call = (cmd: string, args: Record<string, unknown>) =>
      (window as unknown as MockWindow).__TAURI_INTERNALS__.invoke(cmd, args)
    const pageId = await call('create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: 'SPACE_PERSONAL',
    })
    await call('create_blocks_batch', {
      specs: Array.from({ length: 60 }, (_, i) => ({
        blockType: 'content',
        content: `block ${i}`,
        parentId: pageId,
        position: null,
      })),
    })
  }, TITLE)
}

function modeSwitch(page: Page) {
  return page.getByRole('radiogroup', { name: 'Editing mode' })
}

test.describe('view header on a mouse window @pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await waitForBoot(page)
    await seedLongPage(page)
    await openPage(page, TITLE)
  })

  test('stays on screen while a narrow window scrolls', async ({ page }) => {
    await page.setViewportSize({ width: 700, height: 800 })
    await page.mouse.move(350, 500)
    await page.mouse.wheel(0, 3000)
    await expect(page.getByText('block 0', { exact: true })).not.toBeInViewport()
    await expect(modeSwitch(page)).toBeInViewport()
    await expect(page.getByRole('button', { name: 'Page actions' })).toBeInViewport()
  })

  test('survives the window narrowing and widening across md', async ({ page }) => {
    for (const width of [700, 1280, 700, 1280]) {
      await page.setViewportSize({ width, height: 800 })
      await expect(modeSwitch(page)).toBeVisible()
    }
  })
})

const iPhone = devices['iPhone 13']

test.describe('view header on a touch device @pages @mobile', () => {
  test.use({
    viewport: { width: 1000, height: 800 },
    hasTouch: iPhone.hasTouch,
    isMobile: iPhone.isMobile,
    userAgent: iPhone.userAgent,
  })

  test('survives the screen widening across md', async ({ page }) => {
    await waitForBoot(page)
    const title = page.locator('[aria-label="Page title"]')
    await openPage(page, 'Getting Started')
    await page.setViewportSize({ width: 700, height: 800 })
    await expect(title).toBeVisible()
    await page.setViewportSize({ width: 1000, height: 800 })
    await expect(title).toBeVisible()
  })
})
