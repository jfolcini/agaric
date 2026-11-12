import { devices } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import {
  expect,
  ipc,
  navigateToView,
  openPage,
  openPageMobile,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * A click or tap on a block that is not being edited puts the caret where it
 * landed (#6562), so fixing a typo mid-paragraph takes one click: the marker
 * typed after the click lands before the character clicked, across a bold run
 * and after a tag chip, on a page, in the journal and under a touch profile.
 */

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const TAG_WORK = '000000000000000000000TAG01'
const PLAIN = 'the quick brown fox jumps over the lazy dog'
const RICH = `say #[${TAG_WORK}] then **bold words** end`
const DAILY_1 = '0000000000000000000BLOCK06'
const DAILY_2 = '0000000000000000000BLOCK07'

/** A page titled `title` holding `texts`, top-level; resolves the blocks' ids. */
async function seedPage(page: Page, title: string, texts: readonly string[]): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of texts) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids.push(row.id)
  }
  return ids
}

/** The viewport point over the left quarter of the first character of `fragment` in `block`. */
async function pointBefore(block: Locator, fragment: string): Promise<{ x: number; y: number }> {
  return block.evaluate((el, f) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const at = (node.textContent ?? '').indexOf(f)
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 1)
      const r = range.getBoundingClientRect()
      return { x: r.left + r.width / 4, y: r.top + r.height / 2 }
    }
    throw new Error(`no text node holds ${f}`)
  }, fragment)
}

const staticBlock = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)

/** Wait out the mount's delayed focus and ProseMirror's selection write-back (`editBlock`). */
async function settleEditor(page: Page): Promise<void> {
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toBeFocused()
  await editor.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))),
  )
}

async function contentOf(page: Page, blockId: string): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
}

test.describe('a click into a block puts the caret where it landed (#6562) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('in plain text, a bold run and after a chip, the typed marker lands at the click', async ({
    page,
  }) => {
    const [plain, rich] = (await seedPage(page, 'Caret page', [PLAIN, RICH])) as [string, string]
    await openPage(page, 'Caret page')
    await expect(staticBlock(page, rich)).toContainText('work then')

    const cases: Array<[string, string, string]> = [
      [plain, 'own fox', PLAIN.replace('own fox', 'Qown fox')],
      [plain, 'quick', PLAIN.replace('quick', 'Qquick')],
      [plain, 'the quick', `Q${PLAIN}`],
      [rich, 'ld words', RICH.replace('ld words', 'Qld words')],
      [rich, 'hen', RICH.replace('hen', 'Qhen')],
    ]
    const expected = new Map([
      [plain, PLAIN],
      [rich, RICH],
    ])
    for (const [id, fragment, after] of cases) {
      const at = await pointBefore(staticBlock(page, id), fragment)
      await page.mouse.click(at.x, at.y)
      await settleEditor(page)
      await page.keyboard.insertText('Q')
      await page.keyboard.press('Escape')
      await expect(staticBlock(page, id)).toBeVisible()
      await expect.poll(() => contentOf(page, id)).toBe(after)
      // Put the text back so the next click measures the seeded layout.
      await ipc(page, 'edit_block', { blockId: id, toText: expected.get(id) })
      await reopenPage(page, 'Caret page')
    }
  })

  test('a click right of a chip that ends the block types after the chip', async ({ page }) => {
    const ending = `ends with #[${TAG_WORK}]`
    const [id] = (await seedPage(page, 'Chip end', [ending])) as [string]
    await openPage(page, 'Chip end')
    const chip = await staticBlock(page, id).getByTestId('tag-ref-chip').boundingBox()
    const box = await staticBlock(page, id).boundingBox()
    if (!chip || !box) throw new Error('the block has no layout box')
    await page.mouse.click(box.x + box.width - 6, chip.y + chip.height / 2)
    await settleEditor(page)
    await page.keyboard.insertText('Q')
    await page.keyboard.press('Escape')
    await expect.poll(() => contentOf(page, id)).toBe(`${ending}Q`)
  })

  test('the clicked caret survives navigating away and back', async ({ page }) => {
    const [plain] = (await seedPage(page, 'Durable caret', [PLAIN])) as [string]
    await openPage(page, 'Durable caret')
    const at = await pointBefore(staticBlock(page, plain), 'rown')
    await page.mouse.click(at.x, at.y)
    await settleEditor(page)
    await page.keyboard.insertText('X')
    await page.keyboard.press('Escape')
    await reopenPage(page, 'Durable caret')
    await expect(staticBlock(page, plain)).toHaveText(PLAIN.replace('rown', 'Xrown'))
  })
})

test.describe('a click into a journal block puts the caret where it landed (#6562) @editor @journal', () => {
  test('in the day view and in the week view', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Journal')
    const day = staticBlock(page, DAILY_1)
    await day.scrollIntoViewIfNeeded()
    const first = await pointBefore(day, 'standup')
    await page.mouse.click(first.x, first.y)
    await settleEditor(page)
    await page.keyboard.insertText('Q')
    await page.keyboard.press('Escape')
    await expect.poll(() => contentOf(page, DAILY_1)).toBe('Morning Qstandup notes go here')

    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const week = staticBlock(page, DAILY_2)
    await week.scrollIntoViewIfNeeded()
    const second = await pointBefore(week, 'project')
    await page.mouse.click(second.x, second.y)
    await settleEditor(page)
    await page.keyboard.insertText('Q')
    await page.keyboard.press('Escape')
    await expect.poll(() => contentOf(page, DAILY_2)).toBe('Review Qproject milestones')
  })
})

test.describe('a tap into a block puts the caret where it landed (#6562) @editor @mobile', () => {
  const phone = devices['Pixel 7']
  test.use({
    viewport: phone.viewport,
    hasTouch: phone.hasTouch,
    isMobile: phone.isMobile,
    deviceScaleFactor: phone.deviceScaleFactor,
    userAgent: phone.userAgent,
  })

  test('a tap mid-word puts the typed marker before the tapped character', async ({ page }) => {
    await waitForBoot(page)
    const [plain] = (await seedPage(page, 'Tap page', [PLAIN])) as [string]
    await openPageMobile(page, 'Tap page')
    const at = await pointBefore(staticBlock(page, plain), 'own fox')
    await page.touchscreen.tap(at.x, at.y)
    await settleEditor(page)
    await page.keyboard.insertText('Q')
    await page.keyboard.press('Escape')
    await expect.poll(() => contentOf(page, plain)).toBe(PLAIN.replace('own fox', 'Qown fox'))
  })
})
