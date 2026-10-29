import type { Locator, Page } from '@playwright/test'

import { blurEditors, expect, readClipboard, test, waitForBoot } from './helpers'

/**
 * The week view mounts one BlockTree per day, and every tree registers its own
 * copy / cut / paste chord listener over the one global selection. A
 * selection spanning two days must reach the clipboard whole, in day order;
 * cut must remove only what reached it; paste must land once, after the last
 * selected block.
 */

// Seed: today's journal page, PAGE03, holds BLOCK06 ("Morning standup notes go here").
const TODAY_BLOCK = '0000000000000000000BLOCK06'
const TODAY_TEXT = 'Morning standup notes go here'
const TODAY_PAGE = '00000000000000000000PAGE03'
const OTHER_TEXT = 'Neighbour day note'
const PASTED = 'Pasted once'

/** Both days' blocks on the clipboard in day order: plain blocks, the Document dialect (#6190). */
function dayOrder(otherFirst: boolean): string {
  return otherFirst ? `${OTHER_TEXT}\n\n${TODAY_TEXT}\n` : `${TODAY_TEXT}\n\n${OTHER_TEXT}\n`
}

function ipc<T>(page: Page, cmd: string, args: unknown): Promise<T> {
  return page.evaluate(
    ({ c, a }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke(c, a)
    },
    { c: cmd, a: args },
  ) as Promise<T>
}

async function children(
  page: Page,
  parentId: string,
): Promise<{ id: string; content: string | null }[]> {
  const resp = await ipc<{ items: { id: string; content: string | null }[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
  })
  return resp.items
}

async function childContents(page: Page, parentId: string): Promise<(string | null)[]> {
  return (await children(page, parentId)).map((r) => r.content)
}

function row(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

function rowsWithText(page: Page, text: string): Locator {
  return page.locator('[data-testid="sortable-block"]').filter({ hasText: text })
}

/**
 * The row's list item. A row off screen renders as a bare placeholder `<li>`
 * with no `sortable-block` inside (useViewportObserver), and the days of a week
 * do not all fit on screen, so this is the handle that exists either way.
 */
function rowSlot(page: Page, blockId: string): Locator {
  return page.locator(`li[data-block-id="${blockId}"]`)
}

async function ctrlSelect(page: Page, blockId: string): Promise<void> {
  await rowSlot(page, blockId).scrollIntoViewIfNeeded()
  await row(page, blockId)
    .locator('[data-testid="block-static"]')
    .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
}

/**
 * Add a block to a second, empty day of the rendered week through its "Add
 * block" button. Returns that block's id and whether its day comes before
 * today's.
 */
async function seedSecondDay(page: Page): Promise<{ otherBlock: string; otherFirst: boolean }> {
  const todayId = await rowSlot(page, TODAY_BLOCK).evaluate(
    (el) => el.closest('section[id^="journal-2"]')?.id ?? '',
  )
  const days = page.locator('section[id^="journal-2"]')
  const ids = await days.evaluateAll((els) => els.map((el) => el.id))
  const emptyDay = days.filter({ hasText: 'No blocks for' }).first()
  const otherId = (await emptyDay.getAttribute('id')) as string
  const otherDay = page.locator(`section[id="${otherId}"]`)
  // The click creates the day's page and seeds its first block.
  await otherDay.getByRole('button', { name: 'Add block' }).click()
  await expect(otherDay.locator('[data-testid="sortable-block"]')).toHaveCount(1)
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toBeVisible()
  await editor.pressSequentially(OTHER_TEXT)
  await expect(editor).toHaveText(OTHER_TEXT)
  await blurEditors(page)
  const other = rowsWithText(page, OTHER_TEXT)
  await expect(other.locator('[data-testid="block-static"]')).toBeVisible()
  const otherBlock = (await other.getAttribute('data-block-id')) as string
  return { otherBlock, otherFirst: ids.indexOf(otherId) < ids.indexOf(todayId) }
}

/**
 * Seed the second day, then return both blocks in selection order. The second
 * is the anchor, whose tree handles the chord.
 */
async function seedAndOrder(
  page: Page,
  laterFirst: boolean,
): Promise<{ first: string; anchor: string; otherBlock: string; otherFirst: boolean }> {
  const { otherBlock, otherFirst } = await seedSecondDay(page)
  const [earlier, later] = otherFirst ? [otherBlock, TODAY_BLOCK] : [TODAY_BLOCK, otherBlock]
  const [first, anchor] = laterFirst ? [later, earlier] : [earlier, later]
  return { first, anchor, otherBlock, otherFirst }
}

test.describe('Week view: block clipboard across two days @editor @journal', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    // Mount every day's tree at once instead of on scroll (DaySection).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Weekly view' }).click()
  })

  for (const laterFirst of [false, true]) {
    const order = laterFirst ? 'later day selected first' : 'earlier day selected first'

    test(`copy puts both days on the clipboard, in day order (${order})`, async ({ page }) => {
      const { first, anchor, otherFirst } = await seedAndOrder(page, laterFirst)
      await blurEditors(page)
      await ctrlSelect(page, first)
      await ctrlSelect(page, anchor)

      await page.keyboard.press('Control+c')
      await expect.poll(() => readClipboard(page)).toBe(dayOrder(otherFirst))
    })

    test(`cut puts both days on the clipboard and removes both (${order})`, async ({ page }) => {
      const { first, anchor, otherBlock, otherFirst } = await seedAndOrder(page, laterFirst)
      const otherPage = (
        await ipc<{ parent_id: string }>(page, 'get_block', { blockId: otherBlock })
      ).parent_id
      await blurEditors(page)
      await ctrlSelect(page, first)
      await ctrlSelect(page, anchor)

      await page.keyboard.press('Control+x')
      await expect.poll(() => readClipboard(page)).toBe(dayOrder(otherFirst))
      await expect.poll(async () => (await children(page, otherPage)).length).toBe(0)
      await expect
        .poll(async () => (await children(page, TODAY_PAGE)).map((r) => r.id))
        .not.toContain(TODAY_BLOCK)
    })

    test(`paste lands once, after the last selected block (${order})`, async ({ page }) => {
      const { first, anchor, otherBlock } = await seedAndOrder(page, laterFirst)
      const otherPage = (
        await ipc<{ parent_id: string }>(page, 'get_block', { blockId: otherBlock })
      ).parent_id
      const [anchorPage, anchorText, restPage] =
        anchor === TODAY_BLOCK
          ? [TODAY_PAGE, TODAY_TEXT, otherPage]
          : [otherPage, OTHER_TEXT, TODAY_PAGE]
      const afterPaste = await childContents(page, anchorPage)
      afterPaste.splice(afterPaste.indexOf(anchorText) + 1, 0, PASTED)
      await ipc(page, 'plugin:clipboard-manager|write_text', { text: `- ${PASTED}\n` })
      await blurEditors(page)
      await ctrlSelect(page, first)
      await ctrlSelect(page, anchor)

      await page.keyboard.press('Control+v')
      await expect.poll(() => childContents(page, anchorPage)).toEqual(afterPaste)
      expect(await childContents(page, restPage)).not.toContain(PASTED)
      await expect(rowsWithText(page, PASTED)).toHaveCount(1)
    })
  }
})
