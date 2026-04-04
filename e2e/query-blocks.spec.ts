import { expect, test } from '@playwright/test'
import { focusBlock, openPage, saveBlock, waitForBoot } from './helpers'

/**
 * E2E tests for query blocks — created via the /query slash command.
 *
 * A query block's content looks like `{{query tag:work}}` or
 * `{{query property:context=@office}}`. The StaticBlock component detects
 * this pattern and renders a <QueryResult> widget that executes the query
 * against the backend (mock IPC in E2E) and displays matching blocks.
 *
 * Seed data (tauri-mock.ts):
 *   TAG_WORK  ("work")     — applied to BLOCK_PROJ_1, BLOCK_PROJ_2, BLOCK_MTG_1
 *   TAG_PERSONAL ("personal") — applied to BLOCK_DAILY_3
 *   Properties:
 *     BLOCK_MTG_1: context=@office, project=alpha
 *     BLOCK_MTG_2: context=@remote, project=beta
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
  const list = page.locator('.suggestion-list')
  await expect(list).toBeVisible({ timeout: 3000 })
  return list
}

// ===========================================================================
// 1. Creating a query block via /query slash command
// ===========================================================================

test.describe('Query block creation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('/query slash command inserts query template into editor', async ({ page }) => {
    await focusBlock(page)
    const list = await typeSlashCommand(page, 'query')

    // The QUERY command should be visible in the suggestion list
    await expect(list.locator('.suggestion-item', { hasText: 'QUERY' })).toBeVisible()

    // Select the query command
    await page.keyboard.press('Enter')

    // The editor should now contain the query template
    const editor = page.locator('.block-editor [contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 3000 })
    await expect(editor).toContainText('{{query', { timeout: 3000 })
  })

  test('/query block renders QueryResult after save', async ({ page }) => {
    await focusBlock(page)

    // Clear the editor content and type a complete query block
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:work}}', { delay: 20 })

    // Save the block
    await saveBlock(page)

    // The first block should now render as a QueryResult component
    const firstBlock = page.locator('.sortable-block').first()
    await expect(firstBlock.locator('.query-result')).toBeVisible({ timeout: 5000 })
  })
})

// ===========================================================================
// 2. Tag-based query (tag:work)
// ===========================================================================

test.describe('Tag-based query blocks', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('tag:work query shows matching blocks', async ({ page }) => {
    await focusBlock(page)

    // Replace block content with a tag query
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:work}}', { delay: 20 })
    await saveBlock(page)

    // The QueryResult should be visible and show results
    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for results to load (should show count, not "...")
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Seed data has 3 blocks tagged with TAG_WORK:
    //   BLOCK_PROJ_1 ("Ship v2.0 release")
    //   BLOCK_PROJ_2 ("Fix login bug")
    //   BLOCK_MTG_1 ("Weekly standup notes")
    // The result count should show "3 results"
    await expect(queryResult).toContainText('3 result', { timeout: 5000 })

    // Verify specific result items are rendered
    await expect(queryResult.locator('.query-result-item', { hasText: 'Ship v2.0 release' })).toBeVisible({ timeout: 3000 })
    await expect(queryResult.locator('.query-result-item', { hasText: 'Fix login bug' })).toBeVisible({ timeout: 3000 })
    await expect(queryResult.locator('.query-result-item', { hasText: 'Weekly standup notes' })).toBeVisible({ timeout: 3000 })
  })

  test('tag:personal query shows matching blocks', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:personal}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for loading to complete
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Seed data has 1 block tagged with TAG_PERSONAL: BLOCK_DAILY_3 ("Buy groceries")
    await expect(queryResult).toContainText('1 result', { timeout: 5000 })
    await expect(queryResult.locator('.query-result-item', { hasText: 'Buy groceries' })).toBeVisible({ timeout: 3000 })
  })

  test('tag query with no matches shows empty state', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:nonexistenttag}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for loading to complete
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Should show "No results" for a non-matching tag
    await expect(queryResult).toContainText('0 result', { timeout: 5000 })
    await expect(queryResult.locator('text=No results')).toBeVisible({ timeout: 3000 })
  })
})

// ===========================================================================
// 3. Property-based query (property:key=value)
// ===========================================================================

test.describe('Property-based query blocks', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('property:context=@office query shows matching blocks', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query property:context=@office}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for loading to complete
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Seed data: BLOCK_MTG_1 has context=@office
    await expect(queryResult).toContainText('1 result', { timeout: 5000 })
    await expect(queryResult.locator('.query-result-item', { hasText: 'Weekly standup notes' })).toBeVisible({ timeout: 3000 })
  })

  test('property:project=beta query shows matching blocks', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query property:project=beta}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for loading to complete
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Seed data: BLOCK_MTG_2 has project=beta
    await expect(queryResult).toContainText('1 result', { timeout: 5000 })
    await expect(queryResult.locator('.query-result-item', { hasText: 'Design review feedback' })).toBeVisible({ timeout: 3000 })
  })
})

// ===========================================================================
// 4. Legacy query syntax (type:tag expr:prefix)
// ===========================================================================

test.describe('Legacy query syntax', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('type:tag expr:work query renders matching blocks', async ({ page }) => {
    await focusBlock(page)

    // Use the legacy explicit-type syntax that /query slash command templates
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query type:tag expr:work}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for loading to complete
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Should find the 3 blocks tagged with "work"
    await expect(queryResult).toContainText('3 result', { timeout: 5000 })
  })

  test('type:property key:context value:@remote query renders matching blocks', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query type:property key:context value:@remote}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for loading to complete
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Seed data: BLOCK_MTG_2 has context=@remote
    await expect(queryResult).toContainText('1 result', { timeout: 5000 })
  })
})

// ===========================================================================
// 5. QueryResult collapse/expand interaction
// ===========================================================================

test.describe('Query result interactions', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('query result header shows expression and can be collapsed', async ({ page }) => {
    await focusBlock(page)

    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:work}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for results to load
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // The header should display the expression
    await expect(queryResult.locator('code')).toContainText('tag:work')

    // Results should be visible initially
    await expect(queryResult.locator('.query-result-item').first()).toBeVisible({ timeout: 3000 })

    // Click the header to collapse
    await queryResult.locator('button').first().click()

    // Results should be hidden after collapse
    await expect(queryResult.locator('.query-result-item')).not.toBeVisible({ timeout: 3000 })
  })

  test('query result shows todo state badges for task blocks', async ({ page }) => {
    await focusBlock(page)

    // Query for blocks tagged "work" — BLOCK_PROJ_1 is TODO, BLOCK_PROJ_2 is DOING
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:work}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    const queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })

    // Wait for loading to complete
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Seed data: BLOCK_PROJ_1 (TODO), BLOCK_PROJ_2 (DOING) have todo_state set
    // The QueryResult renders todo_state badges for blocks that have them
    await expect(queryResult.locator('text=TODO')).toBeVisible({ timeout: 3000 })
    await expect(queryResult.locator('text=DOING')).toBeVisible({ timeout: 3000 })
  })
})

// ===========================================================================
// 6. Query results update when matching blocks change
// ===========================================================================

test.describe('Query result reactivity', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('editing a query block expression updates the results', async ({ page }) => {
    // First, create a tag:work query
    await focusBlock(page)
    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:work}}', { delay: 20 })
    await saveBlock(page)

    const firstBlock = page.locator('.sortable-block').first()
    let queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })

    // Should show 3 results for tag:work
    await expect(queryResult).toContainText('3 result', { timeout: 5000 })

    // Now click to re-enter edit mode and change to tag:personal
    await firstBlock.locator('.block-static').click()
    const editor = page.locator('.block-editor [contenteditable="true"]')
    await expect(editor).toBeVisible({ timeout: 3000 })

    await page.keyboard.press('Meta+a')
    await page.keyboard.type('{{query tag:personal}}', { delay: 20 })
    await saveBlock(page)

    // The query should now show 1 result for tag:personal
    queryResult = firstBlock.locator('.query-result')
    await expect(queryResult).toBeVisible({ timeout: 5000 })
    await expect(queryResult.locator('text=...')).not.toBeVisible({ timeout: 5000 })
    await expect(queryResult).toContainText('1 result', { timeout: 5000 })
    await expect(queryResult.locator('.query-result-item', { hasText: 'Buy groceries' })).toBeVisible({ timeout: 3000 })
  })
})
