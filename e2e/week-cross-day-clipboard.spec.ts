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

/** The clipboard for both blocks, in day order. */
function dayOrder(otherFirst: boolean): string {
  return otherFirst ? `- ${OTHER_TEXT}\n- ${TODAY_TEXT}\n` : `- ${TODAY_TEXT}\n- ${OTHER_TEXT}\n`
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

function row(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
}

function rowsWithText(page: Page, text: string): Locator {
  return page.locator('[data-testid="sortable-block"]').filter({ hasText: text })
}

async function ctrlSelect(page: Page, blockId: string): Promise<void> {
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
  await expect(row(page, TODAY_BLOCK)).toBeVisible()
  const days = page.locator('section[id^="journal-2"]')
  const ids = await days.evaluateAll((els) => els.map((el) => el.id))
  const todayId = await row(page, TODAY_BLOCK).evaluate(
    (el) => el.closest('section[id^="journal-2"]')?.id ?? '',
  )
  const emptyDay = days.filter({ hasText: 'No blocks for' }).first()
  const otherId = (await emptyDay.getAttribute('id')) as string
  const otherDay = page.locator(`section[id="${otherId}"]`)
  // The first click creates the day's page; the week view seeds no block in
  // it, so the second (the page's own "Add block") creates one.
  await otherDay.getByRole('button', { name: 'Add block' }).click()
  await expect(otherDay.getByText('No blocks for')).toHaveCount(0)
  await otherDay.getByRole('button', { name: 'Add block' }).click()
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

test.describe('Week view: block clipboard across two days', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    // Mount every day's tree at once instead of on scroll (DaySection).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    await page.getByRole('tab', { name: 'Weekly view' }).click()
  })

  test('copy puts both days on the clipboard, in day order', async ({ page }) => {
    const { otherBlock, otherFirst } = await seedSecondDay(page)
    const [earlier, later] = otherFirst ? [otherBlock, TODAY_BLOCK] : [TODAY_BLOCK, otherBlock]
    await blurEditors(page)
    // The later day holds the anchor (the last selected), so its tree handles
    // the chord and must still put the earlier day first.
    await ctrlSelect(page, earlier)
    await ctrlSelect(page, later)

    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toBe(dayOrder(otherFirst))
  })

  test('cut puts both days on the clipboard and removes both', async ({ page }) => {
    const { otherBlock, otherFirst } = await seedSecondDay(page)
    const otherPage = (await ipc<{ parent_id: string }>(page, 'get_block', { blockId: otherBlock }))
      .parent_id
    await blurEditors(page)
    await ctrlSelect(page, TODAY_BLOCK)
    await ctrlSelect(page, otherBlock)

    await page.keyboard.press('Control+x')
    await expect.poll(() => readClipboard(page)).toBe(dayOrder(otherFirst))
    await expect.poll(async () => (await children(page, otherPage)).length).toBe(0)
    await expect
      .poll(async () => (await children(page, TODAY_PAGE)).map((r) => r.id))
      .not.toContain(TODAY_BLOCK)
  })

  test('paste lands once, after the last selected block', async ({ page }) => {
    const { otherBlock } = await seedSecondDay(page)
    const otherPage = (await ipc<{ parent_id: string }>(page, 'get_block', { blockId: otherBlock }))
      .parent_id
    await ipc(page, 'plugin:clipboard-manager|write_text', { text: `- ${PASTED}\n` })
    await blurEditors(page)
    await ctrlSelect(page, TODAY_BLOCK)
    await ctrlSelect(page, otherBlock)

    await page.keyboard.press('Control+v')
    await expect
      .poll(async () => (await children(page, otherPage)).map((r) => r.content))
      .toEqual([OTHER_TEXT, PASTED])
    expect((await children(page, TODAY_PAGE)).map((r) => r.content)).not.toContain(PASTED)
    await expect(rowsWithText(page, PASTED)).toHaveCount(1)
  })
})
