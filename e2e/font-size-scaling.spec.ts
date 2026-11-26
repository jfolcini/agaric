/**
 * #5369 — Settings › Appearance › Font size scales a block's text together
 * with its row controls (the task checkbox, the due-date chip's icon), keeps
 * Medium at today's pixels, and leaves the app chrome (a sidebar icon) fixed.
 * A table's cells, a code block, a callout's label and a block's chips are
 * note text too, a step or two smaller, and grow with it (#7040).
 * This is geometry, which happy-dom cannot measure.
 */

import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import { expect, focusBlockById, ipc, openPage, test, waitForBoot } from './helpers'

const PAGE = 'Projects'
const TASK = 'Fix login bug'
/** `FONT_SIZE_PX` in `src/hooks/useFontSize.ts`. */
const TEXT_PX = { small: 14, medium: 16, large: 18 } as const
/** Today's sizes at Medium: the 16px checkbox and the 14px chip icon. */
const MEDIUM = { text: 16, checkbox: 16, chipIcon: 14 } as const
/** A table cell, a code block and a callout's label at Medium: `text-sm`. */
const MEDIUM_SMALL_TEXT = 14
/** At Medium: chip text (`text-xs`), a chip's height around it (its padding and border), a property chip's icon, and page mode's chip text. */
const MEDIUM_CHIP = { text: 12, chrome: 6, propertyIcon: 10, pageText: 11 } as const
/** The sidebar nav icon: the nav row's `size-4`, chrome, the same at every setting. */
const SIDEBAR_ICON_PX = 16

function fontSize(locator: Locator): Promise<string> {
  return locator.evaluate((el) => getComputedStyle(el).fontSize)
}

/** A page of `contents` blocks, returning their ids. */
async function seedPage(page: Page, title: string, contents: string[]): Promise<string[]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SEED_IDS.SPACE_PERSONAL,
  })
  const ids: string[] = []
  for (const content of contents) {
    const { id } = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
    })
    ids.push(id)
  }
  return ids
}

function blockRow(page: Page, id: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
}

async function height(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  expect(box, 'element must have a layout box').not.toBeNull()
  return box?.height ?? Number.NaN
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
      const title = `Small text ${size}`
      const [table = '', code = ''] = await seedPage(page, title, [
        '| Screen | Owner |\n| --- | --- |\n| Journal | Ana |',
        '```ts\nconst step = 4\n```',
      ])
      await openPage(page, title)

      const small = `${(MEDIUM_SMALL_TEXT * textPx) / MEDIUM.text}px`
      await expect(blockRow(page, table).getByRole('cell', { name: 'Ana' })).toBeVisible()
      expect(
        await fontSize(blockRow(page, table).getByRole('cell', { name: 'Ana' })),
        'table cell',
      ).toBe(small)
      expect(await fontSize(blockRow(page, code).locator('pre')), 'code block').toBe(small)

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

    test('chip text and a callout label keep their ratio to the block text', async ({ page }) => {
      const title = `Chips ${size}`
      const [task = '', study = '', callout = ''] = await seedPage(page, title, [
        'Ship the release',
        'Usability study',
        '> [!NOTE] Decision\n> Use bottom sheets.',
      ])
      await seedPage(page, `${title} refs`, [`See ((${task}))`])
      await ipc(page, 'set_todo_state', { blockId: task, state: 'TODO' })
      await ipc(page, 'set_priority', { blockId: task, level: '1' })
      await ipc(page, 'set_due_date', { blockId: task, date: '2030-01-15' })
      await ipc(page, 'set_property', {
        blockId: task,
        key: 'repeat',
        value: {
          value_text: '+1w',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
      await ipc(page, 'set_property', {
        blockId: study,
        key: 'effort',
        value: {
          value_text: '1d',
          value_num: null,
          value_date: null,
          value_ref: null,
          value_bool: null,
        },
      })
      await openPage(page, title)

      const scale = textPx / MEDIUM.text
      const chipText = `${MEDIUM_CHIP.text * scale}px`
      const chipHeight = MEDIUM_CHIP.text * scale + MEDIUM_CHIP.chrome
      const priority = blockRow(page, task).getByTestId('priority-badge').locator('span')
      await expect(priority).toHaveText('P1')
      expect(await fontSize(priority), 'priority badge').toBe(chipText)
      expect(await height(priority), 'priority badge height').toBeCloseTo(chipHeight, 1)
      expect(
        await fontSize(blockRow(page, task).getByRole('button', { name: /^Due / })),
        'due chip',
      ).toBe(chipText)
      expect(await fontSize(blockRow(page, task).locator('.repeat-indicator')), 'repeat chip').toBe(
        chipText,
      )
      const refCount = blockRow(page, task).getByTestId('ref-count-chip')
      await expect(refCount).toHaveText('1')
      expect(await fontSize(refCount), 'reference count').toBe(chipText)

      const property = blockRow(page, study).getByTestId('property-chip')
      expect(await fontSize(property), 'property chip').toBe(chipText)
      expect(await height(property), 'property chip height').toBeCloseTo(chipHeight, 1)
      expect(await width(property.locator('svg')), 'property chip icon').toBeCloseTo(
        MEDIUM_CHIP.propertyIcon * scale,
        1,
      )

      const label = blockRow(page, callout)
        .getByTestId('callout-block')
        .getByText('Note', { exact: true })
      expect(await fontSize(label), 'callout label').toBe(
        `${(MEDIUM_SMALL_TEXT * textPx) / MEDIUM.text}px`,
      )

      // Page mode draws them as smaller text, which grows as well.
      await page
        .getByRole('radiogroup', { name: 'Editing mode' })
        .getByRole('radio', { name: 'Page' })
        .click()
      const pagePriority = page
        .locator(`[data-page-block-id="${task}"] [data-testid="priority-badge"]`)
        .locator('span')
      await expect(pagePriority).toHaveText('P1')
      expect(await fontSize(pagePriority), 'page-mode priority').toBe(
        `${MEDIUM_CHIP.pageText * scale}px`,
      )
    })
  })
}
