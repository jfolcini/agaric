import { expect, test } from '@playwright/test'
import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

/**
 * E2E tests for slash commands (/ picker).
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks:
 *     GS_1: "Welcome to Agaric! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *
 * Slash command behaviour:
 *   - Typing / in the editor opens the suggestion popup
 *   - Base commands (empty query): TODO, DOING, DONE, DATE
 *   - Priority commands (progressive disclosure — query must match): PRIORITY 1, 2, 3
 *   - Heading commands (progressive disclosure — query must match): Heading 1–6
 *   - Enter selects the first matching item; ArrowDown/Up to navigate
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Type a slash command filter inside the currently focused editor.
 * Moves to end of line, types ` /<command>`, and waits for the
 * suggestion list to appear.
 */
async function typeSlashCommand(page: import('@playwright/test').Page, command: string) {
  await page.keyboard.press('End')
  await page.keyboard.type(` /${command}`, { delay: 30 })
  const list = page.locator('[data-testid="suggestion-list"]')
  await expect(list).toBeVisible()
  return list
}

// ===========================================================================
// 1. Slash menu basics
// ===========================================================================

test.describe('Slash menu basics', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('typing / opens the slash command menu', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, '')
    await expect(list).toBeVisible()
  })

  test('slash menu shows base commands', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, '')

    await expect(list.locator('[data-testid="suggestion-item"]', { hasText: 'TODO' })).toBeVisible()
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'DOING' }),
    ).toBeVisible()
    await expect(list.locator('[data-testid="suggestion-item"]', { hasText: 'DONE' })).toBeVisible()
    await expect(list.locator('[data-testid="suggestion-item"]', { hasText: 'DATE' })).toBeVisible()
  })

  test('Escape closes slash menu', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, '')
    await expect(list).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(list).not.toBeVisible()
  })
})

// ===========================================================================
// 2. Task commands
// ===========================================================================

test.describe('Task commands', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('/todo sets block as TODO and persists after save', async ({ page }) => {
    await focusBlock(page)
    await typeSlashCommand(page, 'todo')
    await page.keyboard.press('Enter')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="task-checkbox-todo"]')).toBeVisible()

    // Save the block and verify TODO persists in static view
    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="task-checkbox-todo"]')).toBeVisible()

    // Re-open the block and verify TODO is still there
    await firstBlock.locator('[data-testid="block-static"]').click()
    await expect(
      page.locator('[data-testid="block-editor"] [contenteditable="true"]'),
    ).toBeVisible()
    await expect(firstBlock.locator('[data-testid="task-checkbox-todo"]')).toBeVisible()
  })

  test('/doing sets block as DOING and persists after save', async ({ page }) => {
    await focusBlock(page)
    await typeSlashCommand(page, 'doing')
    await page.keyboard.press('Enter')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="task-checkbox-doing"]')).toBeVisible()

    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="task-checkbox-doing"]')).toBeVisible()
  })

  test('/done sets block as DONE and persists after save', async ({ page }) => {
    await focusBlock(page)
    await typeSlashCommand(page, 'done')
    await page.keyboard.press('Enter')

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="task-checkbox-done"]')).toBeVisible()

    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="task-checkbox-done"]')).toBeVisible()
  })
})

// ===========================================================================
// 3. Priority commands (progressive disclosure)
// ===========================================================================

test.describe('Priority commands', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('/priority shows priority commands', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, 'priority')

    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'PRIORITY 1' }),
    ).toBeVisible()
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'PRIORITY 2' }),
    ).toBeVisible()
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'PRIORITY 3' }),
    ).toBeVisible()
  })

  test('/priority 1 sets high priority and persists after save', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, 'priority')
    const item = list.locator('[data-testid="suggestion-item"]', { hasText: 'PRIORITY 1' })
    await expect(item).toBeVisible()
    await item.click()

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const badge = firstBlock.locator('[data-testid="priority-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('1')

    // Save and verify persists
    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toBeVisible()
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toContainText('1')
  })

  test('/priority 2 sets medium priority and persists after save', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, 'priority')
    const item = list.locator('[data-testid="suggestion-item"]', { hasText: 'PRIORITY 2' })
    await expect(item).toBeVisible()
    await item.click()

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const badge = firstBlock.locator('[data-testid="priority-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('2')

    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toBeVisible()
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toContainText('2')
  })

  test('/priority 3 sets low priority and persists after save', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, 'priority')
    const item = list.locator('[data-testid="suggestion-item"]', { hasText: 'PRIORITY 3' })
    await expect(item).toBeVisible()
    await item.click()

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const badge = firstBlock.locator('[data-testid="priority-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText('3')

    await saveBlock(page)
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toBeVisible()
    await expect(firstBlock.locator('[data-testid="priority-badge"]')).toContainText('3')
  })
})

// ===========================================================================
// 4. Heading commands (progressive disclosure)
// ===========================================================================

test.describe('Heading commands', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('/h1 sets heading level 1 and persists after save', async ({ page }) => {
    await focusBlock(page)

    // "heading" matches all heading commands; first is "Heading 1"
    const list = await typeSlashCommand(page, 'heading')
    await expect(
      list.locator('[data-testid="suggestion-item"]', { hasText: 'Heading 1' }),
    ).toBeVisible()
    await page.keyboard.press('Enter')

    // Editor re-mounts with # prefix -- wait for it to settle
    await expect(
      page.locator('[data-testid="block-editor"] [contenteditable="true"]'),
    ).toBeVisible()

    // Save the block (Enter) instead of Escape (which cancels)
    await saveBlock(page)

    // The first block should render an <h1> heading in static view
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('h1')).toBeVisible()
  })

  test('/h2 sets heading level 2 and persists after save', async ({ page }) => {
    await focusBlock(page)

    // "heading" matches all heading commands; click "Heading 2" directly
    const list = await typeSlashCommand(page, 'heading')
    const h2Item = list.locator('[data-testid="suggestion-item"]', { hasText: 'Heading 2' })
    await expect(h2Item).toBeVisible()
    await h2Item.click()

    // Editor re-mounts with ## prefix
    await expect(
      page.locator('[data-testid="block-editor"] [contenteditable="true"]'),
    ).toBeVisible()

    // Save the block (Enter) instead of Escape (which cancels)
    await saveBlock(page)

    // The first block should render an <h2> heading in static view
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('h2')).toBeVisible()
  })
})

// ===========================================================================
// 5. Date command
// ===========================================================================

test.describe('Date command', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('/date opens the date picker', async ({ page }) => {
    await focusBlock(page)
    await typeSlashCommand(page, 'date')
    await page.keyboard.press('Enter')

    await expect(page.locator('[data-testid="date-picker-popup"]')).toBeVisible()
  })
})
