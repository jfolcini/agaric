import type { Page } from '@playwright/test'

import { expect, test } from './helpers'

const TITLE = 'Scroll restore long page'

async function emitMockEvent(page: Page, event: string, payload: unknown) {
  await page.evaluate(
    ({ event: evt, payload: data }) =>
      (
        window as unknown as { __emitMockEvent: (e: string, p: unknown) => Promise<void> }
      ).__emitMockEvent(evt, data),
    { event, payload },
  )
}

/** The text and offset of the first block row at the top of the scroll pane. */
async function topRow(page: Page) {
  return page.evaluate(() => {
    const pane = document.getElementById('main-content') as HTMLElement
    const top = pane.getBoundingClientRect().top
    for (const row of document.querySelectorAll<HTMLElement>('li[data-block-id]')) {
      const rect = row.getBoundingClientRect()
      if (rect.bottom > top + 1) {
        return { text: (row.textContent ?? '').slice(0, 8), offset: Math.round(rect.top - top) }
      }
    }
    return null
  })
}

/**
 * #754 restores a page's scroll offset when the user comes back to it. Rows
 * past a tree's initial window mount as placeholders (#5329), so the offset
 * lands on the row the user left only if those placeholders keep the heights
 * measured on the first visit; at the estimate it landed some 80 rows lower.
 */
test('coming back to a long page restores the row the user left', async ({ page }) => {
  await page.goto('/')
  await page.locator('[data-testid="block-static"]').first().waitFor()
  const pageId = await page.evaluate(async (title) => {
    const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
      invoke: (cmd: string, args: unknown) => Promise<unknown>
    }
    const parentId = (await internals.invoke('create_page_in_space', {
      parentId: null,
      content: title,
      spaceId: 'SPACE_PERSONAL',
    })) as string
    await internals.invoke('create_blocks_batch', {
      specs: Array.from({ length: 500 }, (_, i) => ({
        blockType: 'content',
        // Wrapped paragraphs, so a row's real height is well past the estimate.
        content: `row ${i} ${'lorem ipsum '.repeat(20)}`,
        parentId,
        position: null,
      })),
    })
    return parentId
  }, TITLE)

  await emitMockEvent(page, 'deeplink:navigate-to-page', { id: pageId })
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)
  await expect(page.locator('li[data-block-id]')).toHaveCount(500)

  const pane = await page.locator('#main-content').boundingBox()
  await page.mouse.move((pane?.x ?? 0) + 300, (pane?.y ?? 0) + 300)
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 200)
    await page.waitForTimeout(50)
  }
  await expect.poll(() => page.locator('#main-content').evaluate((el) => el.scrollTop)).toBe(6000)
  const left = await topRow(page)
  expect(left?.text).toMatch(/^row \d+/)

  await page.getByRole('button', { name: 'Journal', exact: true }).first().click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveCount(0)
  await emitMockEvent(page, 'deeplink:navigate-to-page', { id: pageId })
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(TITLE)

  await expect.poll(() => topRow(page)).toEqual(left)
})
