/**
 * #5369 — Settings › Appearance › Font size scales a block's text together
 * with its row controls (the task checkbox, the due-date chip's icon), keeps
 * Medium at today's pixels, and leaves the app chrome (a sidebar icon) fixed.
 * A table's cells and a code block are note text too, a step smaller (#7040).
 * This is geometry, which happy-dom cannot measure.
 */

import type { Locator } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, focusBlockById, ipc, openPage, test, waitForBoot } from './helpers'

const PAGE = 'Projects'
const TASK = 'Fix login bug'
/** `FONT_SIZE_PX` in `src/hooks/useFontSize.ts`. */
const TEXT_PX = { small: 14, medium: 16, large: 18 } as const
/** Today's sizes at Medium: the 16px checkbox and the 14px chip icon. */
const MEDIUM = { text: 16, checkbox: 16, chipIcon: 14 } as const
/** A table cell and a code block at Medium: `text-sm`. */
const MEDIUM_SMALL_TEXT = 14
/** The sidebar nav icon: the nav row's `size-4`, chrome, the same at every setting. */
const SIDEBAR_ICON_PX = 16

function fontSize(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).fontSize)
}

async function width(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box, 'element must have a layout box').not.toBeNull()
  return box?.width ?? Number.NaN
}

for (const [size, textPx] of Object.entries(TEXT_PX)) {
  test.describe(`font size ${size} @settings @editor`, () => {
    test.use({ viewport: { width: 1440, height: 900 } })

    test.beforeEach(async ({ page }) => {
      await page.addInitScript((s) => localStorage.setItem('agaric-font-size', s), size)
      await waitForBoot(page)
      await openPage(page, PAGE)
    })

    test('row controls keep their ratio to the block text; the sidebar does not move', async ({
      page,
    }, testInfo) => {
      const row = page.locator('[data-testid="sortable-block"]', { hasText: TASK })
      const text = row.getByTestId('block-static')
      await expect(text).toBeVisible()
      expect(await text.evaluate((el) => getComputedStyle(el).fontSize)).toBe(`${textPx}px`)

      const scale = textPx / MEDIUM.text
      const checkbox = await width(row.getByTestId('task-checkbox-doing'))
      expect(checkbox, 'checkbox').toBeCloseTo(MEDIUM.checkbox * scale, 1)
      const chipIcon = await width(row.getByRole('button', { name: /^Due / }).locator('svg'))
      expect(chipIcon, 'due-date chip icon').toBeCloseTo(MEDIUM.chipIcon * scale, 1)

      const sidebarIcon = page
        .locator('[data-slot="sidebar"]')
        .getByRole('button', { name: 'Pages', exact: true })
        .locator('svg')
      expect(await width(sidebarIcon), 'sidebar icon').toBeCloseTo(SIDEBAR_ICON_PX, 1)

      if (size === 'large') {
        await testInfo.attach('page-at-large', {
          body: await page.screenshot(),
          contentType: 'image/png',
        })
      }
    })

    test('a table and a code block keep their ratio to the block text, read and edited', async ({
      page,
    }) => {
      const scope = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }
      const title = `Small text ${size}`
      const pageId = await ipc<string>(page, 'create_page_in_space', {
        parentId: null,
        content: title,
        spaceId: SEED_IDS.SPACE_PERSONAL,
      })
      const create = async (content: string): Promise<string> =>
        (
          await ipc<{ id: string }>(page, 'create_block', {
            blockType: 'content',
            content,
            parentId: pageId,
            index: null,
            scope,
          })
        ).id
      const table = await create('| Screen | Owner |\n| --- | --- |\n| Journal | Ana |')
      const code = await create('```ts\nconst step = 4\n```')
      await openPage(page, title)

      const small = `${(MEDIUM_SMALL_TEXT * textPx) / MEDIUM.text}px`
      const row = (id: string) =>
        page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
      await expect(row(table).getByRole('cell', { name: 'Ana' })).toBeVisible()
      expect(await fontSize(row(table).getByRole('cell', { name: 'Ana' })), 'table cell').toBe(
        small,
      )
      expect(await fontSize(row(code).locator('pre')), 'code block').toBe(small)

      await focusBlockById(page, table)
      const editor = page.locator('[data-testid="block-editor"] .ProseMirror')
      expect(await fontSize(editor.getByRole('cell', { name: 'Ana' })), 'edited table cell').toBe(
        small,
      )
      await focusBlockById(page, code)
      const pre = editor.locator('pre')
      expect(await fontSize(pre), 'edited code block').toBe(small)
      // Its revealed fences, on lines of their own in the room its margins leave.
      await expect(pre).toHaveClass(/md-reveal-block-syntax/)
      const fence = await pre.evaluate((el) => {
        const style = getComputedStyle(el, '::before')
        return {
          size: style.fontSize,
          line: style.lineHeight,
          margin: getComputedStyle(el).marginTop,
        }
      })
      expect(fence.size, 'code fence').toBe(small)
      expect(fence.margin, "the fence's room").toBe(fence.line)
    })
  })
}
