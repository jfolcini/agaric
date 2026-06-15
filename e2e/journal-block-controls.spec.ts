import { expect, test } from './helpers'

/**
 * #1243 — In the Journal (Day/Week/Month) views the per-block gutter controls
 * (drag handle, history, delete) must reveal ONLY for the block the user is
 * engaging (hover / focus-within / multi-select / open editor), exactly like
 * the page editor. The regression: `DaySection` wrapped the whole `BlockTree`
 * in a bare `group`, and Tailwind `group-hover:` matches ANY ancestor with the
 * `group` class — so hovering anywhere in the day revealed EVERY row's controls
 * at once. The existing #370 test only covered the page editor (no such
 * wrapper), so it stayed green. This spec exercises the journal render path.
 */

/** Add a block to the (default) journal daily view via the Add block button. */
async function addJournalBlock(page: import('@playwright/test').Page, text: string) {
  await page
    .getByRole('button', { name: /add block/i })
    .first()
    .click()
  const editor = page.getByRole('textbox', { name: 'Block editor' })
  await expect(editor).toBeVisible({ timeout: 5000 })
  await editor.pressSequentially(text, { delay: 15 })
  await editor.press('Enter')
  const fresh = page.getByRole('textbox', { name: 'Block editor' })
  if (await fresh.isVisible().catch(() => false)) await fresh.press('Escape')
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible()
}

const dragHandleOpacity = (block: import('@playwright/test').Locator) =>
  block
    .locator('[data-testid="drag-handle"]')
    .evaluate((el) => Number.parseFloat(getComputedStyle(el as HTMLElement).opacity))

test.describe('Journal gutter controls reveal per-block (#1243)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('hovering one block reveals only its own gutter controls, not every block', async ({
    page,
  }) => {
    // Two sibling blocks are enough to prove the contract; the daily-view
    // Enter/Escape flow nets a variable count, so assert ≥ 2 rather than a
    // fixed number.
    await addJournalBlock(page, 'Alpha journal block')
    await addJournalBlock(page, 'Bravo journal block')
    await addJournalBlock(page, 'Charlie journal block')

    const blocks = page.locator('[data-testid="sortable-block"]')
    await expect.poll(() => blocks.count()).toBeGreaterThanOrEqual(2)

    const first = blocks.nth(0)
    const second = blocks.nth(1)

    // At rest (cursor parked off the list), no grip is painted on any row.
    await page.mouse.move(0, 0)
    await expect.poll(() => dragHandleOpacity(first)).toBe(0)
    await expect.poll(() => dragHandleOpacity(second)).toBe(0)

    // Hovering the SECOND block reveals ONLY its own handle …
    await second.hover()
    await expect.poll(() => dragHandleOpacity(second)).toBe(1)
    // … the sibling row stays hidden (the #1243 regression revealed every
    // row at once because a `group` ancestor wrapped the whole day).
    await expect.poll(() => dragHandleOpacity(first)).toBe(0)
  })
})
