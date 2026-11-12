/**
 * The table's own handles (#6607) against the mock backend, in block mode's roving
 * editor and in page mode's document: add and delete rows and columns, drag a row and
 * a column, move them from the keyboard, and sort by a column. Each result is read from
 * the stored block, then again after leaving the page and coming back.
 */

import type { Locator, Page } from '@playwright/test'
import { devices } from '@playwright/test'

import { expect, focusBlockById, ipc, openPageMobile, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const PAGE_EDITOR = '[data-testid="page-mode-editor"]'

type Mode = 'Blocks' | 'Page'

async function seedPage(page: Page, title: string, content: string): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const row = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId: pageId,
    index: null,
    scope: SCOPE,
  })
  return row.id
}

async function openViaPalette(page: Page, title: string): Promise<void> {
  // Escape leaves the block (block mode) or the document (page mode); both save.
  await page.keyboard.press('Escape')
  await expect
    .poll(() =>
      page.evaluate(() => document.activeElement?.closest('[contenteditable="true"]') != null),
    )
    .toBe(false)
  await page.keyboard.press('Control+k')
  const input = page.locator('[cmdk-input]').first()
  await input.fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

/** Opens `title` in `mode` with the editor on its table block, and returns the live table. */
async function editTable(page: Page, title: string, id: string, mode: Mode): Promise<Locator> {
  await openViaPalette(page, title)
  const radio = page.getByRole('radiogroup', { name: 'Editing mode' }).getByRole('radio', {
    name: mode,
  })
  if ((await radio.getAttribute('aria-checked')) !== 'true') await radio.click()
  if (mode === 'Blocks') {
    await focusBlockById(page, id)
    return page.locator('[data-testid="block-editor"] table')
  }
  return page.locator(`${PAGE_EDITOR} [data-page-block-id="${id}"] table`)
}

const cell = (table: Locator, text: string): Locator =>
  table.locator('td, th').filter({ hasText: new RegExp(`^${text}$`) })

/**
 * Clicks the cell holding `text` and waits for the handles to sit on its row and column,
 * within a few pixels: far less than a row's height or a column's width.
 * The DOM selection moves on the click, the editor's only a `selectionchange` later, and
 * the handles and the move keys act on the editor's.
 */
async function caretTo(table: Locator, text: string): Promise<void> {
  const target = cell(table, text)
  await target.click()
  await expect
    .poll(() =>
      target.evaluate((el) => {
        const box = el.getBoundingClientRect()
        const row = document.querySelector('[data-testid="table-row-handle"]')
        const column = document.querySelector('[data-testid="table-column-handle"]')
        if (row === null || column === null) return false
        const r = row.getBoundingClientRect()
        const c = column.getBoundingClientRect()
        return (
          Math.abs(r.top + r.height / 2 - (box.top + box.height / 2)) < 4 &&
          Math.abs(c.left + c.width / 2 - (box.left + box.width / 2)) < 4
        )
      }),
    )
    .toBe(true)
}

const stored = async (page: Page, id: string): Promise<string> =>
  (await ipc<{ content: string | null }>(page, 'get_block', { blockId: id })).content ?? ''

/** Leaves the page, which saves it, checks the stored table, and checks it again on return. */
async function expectSaved(page: Page, title: string, id: string, markdown: string) {
  // A closing menu, or the tooltip of a handle that moved under the resting pointer, takes
  // an Escape for itself.
  await page.mouse.move(1, 1)
  await expect(page.locator('[data-slot="popover-content"], [role="tooltip"]')).toHaveCount(0)
  await openViaPalette(page, 'Getting Started')
  await expect.poll(() => stored(page, id)).toBe(markdown)
  await openViaPalette(page, title)
  await expect.poll(() => stored(page, id)).toBe(markdown)
  const header = markdown.split('\n')[0]?.split('|')[1]?.trim() ?? ''
  await expect(page.locator('table th').first()).toHaveText(header)
}

async function dragTo(page: Page, handle: Locator, target: Locator): Promise<void> {
  const from = await handle.boundingBox()
  const to = await target.boundingBox()
  if (from === null || to === null) throw new Error('dragTo: no layout box')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await expect(page.getByTestId('table-drop-line')).toBeVisible()
  await page.mouse.up()
}

/** A one-finger drag from `handle` to `target`, as the touch screen sends it. */
async function fingerDrag(page: Page, handle: Locator, target: Locator): Promise<void> {
  const from = await handle.boundingBox()
  const to = await target.boundingBox()
  if (from === null || to === null) throw new Error('fingerDrag: no layout box')
  const cdp = await page.context().newCDPSession(page)
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
    })
  const [x0, y0] = [from.x + from.width / 2, from.y + from.height / 2]
  const [x1, y1] = [to.x + to.width / 2, to.y + to.height / 2]
  await touch('touchStart', x0, y0)
  for (let i = 1; i <= 8; i++)
    await touch('touchMove', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8)
  await expect(page.getByTestId('table-drop-line')).toBeVisible()
  await touch('touchEnd', x1, y1)
  await cdp.detach()
}

const rowHandle = (page: Page) => page.getByRole('button', { name: 'Row actions' })
const columnHandle = (page: Page) => page.getByRole('button', { name: 'Column actions' })

const MOVES = [
  '| h1 | h2 | h3 |',
  '| --- | --- | --- |',
  '| a | 1 | x |',
  '| b | 2 | y |',
  '| c | 3 | z |',
].join('\n')

for (const mode of ['Blocks', 'Page'] as const) {
  test.describe(`table handles in ${mode.toLowerCase()} mode @editor @pages @markdown`, () => {
    test.beforeEach(async ({ page }) => {
      await waitForBoot(page)
    })

    test('adds and deletes a row and a column through the handles', async ({ page }) => {
      const title = `Handles add ${mode}`
      const id = await seedPage(page, title, '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
      const table = await editTable(page, title, id, mode)

      await caretTo(table, '1')
      await page.getByRole('button', { name: 'Add row' }).click()
      await expect(table.locator('tr')).toHaveCount(4)
      await page.getByRole('button', { name: 'Add column' }).click()
      await expect(table.locator('tr').first().locator('th')).toHaveCount(3)

      await caretTo(table, '3')
      await rowHandle(page).click()
      await page.getByRole('menuitem', { name: 'Delete row' }).click()
      await expect(table.locator('tr')).toHaveCount(3)
      await caretTo(table, 'b')
      await columnHandle(page).click()
      await page.getByRole('menuitem', { name: 'Delete column' }).click()
      await expect(table.locator('tr').first().locator('th')).toHaveCount(2)

      await expectSaved(page, title, id, '| a |  |\n| --- | --- |\n| 1 |  |\n|  |  |')
    })

    test('drags a row and a column to where they are dropped', async ({ page }) => {
      const title = `Handles drag ${mode}`
      const id = await seedPage(page, title, MOVES)
      const table = await editTable(page, title, id, mode)

      await caretTo(table, 'a')
      await dragTo(page, rowHandle(page), cell(table, 'c'))
      await expect(table.locator('tr').last()).toContainText('a')
      await caretTo(table, 'h3')
      await dragTo(page, columnHandle(page), cell(table, 'h1'))
      await expect(table.locator('th').first()).toHaveText('h3')

      await expectSaved(
        page,
        title,
        id,
        [
          '| h3 | h1 | h2 |',
          '| --- | --- | --- |',
          '| y | b | 2 |',
          '| z | c | 3 |',
          '| x | a | 1 |',
        ].join('\n'),
      )
    })

    test('moves a row and a column from the keyboard, one undo taking back one move', async ({
      page,
    }) => {
      const title = `Handles keys ${mode}`
      const id = await seedPage(page, title, MOVES)
      const table = await editTable(page, title, id, mode)

      await caretTo(table, 'a')
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await page.keyboard.press('Alt+Shift+ArrowDown')
      await expect(table.locator('tr').last()).toContainText('a')
      await page.keyboard.press('Alt+Shift+ArrowRight')
      await expect(table.locator('th').first()).toHaveText('h2')
      await page.keyboard.press('Control+z')
      await expect(table.locator('th').first()).toHaveText('h1')
      await expect(table.locator('tr').last()).toContainText('a')

      await expectSaved(
        page,
        title,
        id,
        [
          '| h1 | h2 | h3 |',
          '| --- | --- | --- |',
          '| b | 2 | y |',
          '| c | 3 | z |',
          '| a | 1 | x |',
        ].join('\n'),
      )
    })

    test('sorts the rows by a column, numbers by value and empty cells last', async ({ page }) => {
      const title = `Handles sort ${mode}`
      const id = await seedPage(
        page,
        title,
        '| item | qty |\n| --- | --- |\n| pear | 10 |\n| fig |  |\n| apple | 9 |',
      )
      const table = await editTable(page, title, id, mode)

      await caretTo(table, 'qty')
      await columnHandle(page).click()
      await page.getByRole('menuitem', { name: 'Sort ascending' }).click()
      await expect(table.locator('tr').nth(1)).toContainText('apple')

      await expectSaved(
        page,
        title,
        id,
        '| item | qty |\n| --- | --- |\n| apple | 9 |\n| pear | 10 |\n| fig |  |',
      )
    })
  })
}

test.describe('table handles on a touch phone @editor @mobile', () => {
  const iPhone13 = devices['iPhone 13']
  test.use({
    viewport: iPhone13.viewport,
    userAgent: iPhone13.userAgent,
    isMobile: iPhone13.isMobile,
    hasTouch: iPhone13.hasTouch,
  })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the handles are 44 px targets; a finger drags a row and a column, and a tap opens the row menu', async ({
    page,
  }) => {
    const title = 'Handles touch'
    const id = await seedPage(page, title, MOVES)
    await openPageMobile(page, title)
    await focusBlockById(page, id)
    const table = page.locator('[data-testid="block-editor"] table')
    await cell(table, 'b').tap()

    for (const name of ['Row actions', 'Column actions', 'Add row', 'Add column']) {
      const box = await page.getByRole('button', { name }).boundingBox()
      expect(box?.width, name).toBe(44)
      expect(box?.height, name).toBe(44)
    }
    // Finger drags, which the block row under the table must not take for its own swipe or drag.
    await fingerDrag(page, rowHandle(page), cell(table, 'a'))
    await expect(table.locator('tr').nth(1)).toContainText('b')
    await fingerDrag(page, columnHandle(page), cell(table, 'h3'))
    await expect(table.locator('th').last()).toHaveText('h1')
    await expect(page.locator(`[data-block-id="${id}"]`).first()).toBeVisible()

    await rowHandle(page).tap()
    await page.getByRole('menuitem', { name: 'Move row down' }).tap()
    await expect(table.locator('tr').nth(1)).toContainText('a')
    await expect(table.locator('tr').nth(2)).toContainText('b')
    await expect(table.locator('th').first()).toHaveText('h2')
  })
})
