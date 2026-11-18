import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeAlertDialog,
  createPageFromPagesView,
  deleteBlockViaContextMenu,
  expect,
  ipc,
  navigateToView,
  openPage,
  test,
  waitForBoot,
  waitForStableBlockRows,
} from './helpers'

// HistoryView tests mutate and assert against the shared
// mock op-log within a describe — same risk profile as undo-redo-blocks,
// run serially to avoid op-log interleaving under fullyParallel.
test.describe.configure({ mode: 'serial' })

/**
 * E2E tests for HistoryView batch revert (#137).
 *
 * Tests the full flow: perform mutations -> navigate to History ->
 * select entries -> confirm revert -> verify state changed.
 *
 * The tauri-mock tracks an op log and supports batch revert.
 */

async function storedText(page: Page, blockId: string): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
}

/** The block's content, or `deleted` once it is soft-deleted or gone. */
async function blockState(page: Page, blockId: string): Promise<string> {
  try {
    const row = await ipc<{ content: string; deleted_at: unknown }>(page, 'get_block', { blockId })
    return row.deleted_at == null ? row.content : 'deleted'
  } catch {
    return 'deleted'
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('HistoryView batch revert @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('history view shows operation entries after mutations', async ({ page }) => {
    // Perform some mutations first
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    // Navigate to History view
    await navigateToView(page, 'History')

    // Verify history entries appear (op log should have create_block op at minimum)
    const historyItems = page.locator('[data-history-item]')
    await expect(historyItems.first()).toBeVisible({ timeout: 5000 })
    const count = await historyItems.count()
    expect(count).toBeGreaterThan(0)
  })

  test('selecting and reverting operations shows confirmation dialog', async ({ page }) => {
    // Create a block to generate an op
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    // Navigate to History
    await navigateToView(page, 'History')
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Click the first history item checkbox to select it
    const firstItem = page.locator('[data-history-item]').first()
    const checkbox = firstItem.getByRole('checkbox')
    await checkbox.click()

    // Selection toolbar should appear with "Revert selected"
    await expect(page.getByText('1 selected')).toBeVisible()
    await expect(page.getByRole('button', { name: /Revert selected/i })).toBeVisible()

    // Click "Revert selected" to trigger confirmation dialog
    await page.getByRole('button', { name: /Revert selected/i }).click()

    // Confirmation dialog should appear
    await expect(page.getByText(/Revert 1 operation/i)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Revert', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  })

  test('batch revert reverses a create_block operation', async ({ page }) => {
    const text = 'the block to revert'
    const created = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content: text,
      parentId: SEED_IDS.PAGE_GETTING_STARTED,
      index: null,
      scope: { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL },
      blockId: null,
    })

    await navigateToView(page, 'History')
    await page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('[data-testid="history-type-badge"][data-op-type="create_block"]'),
      })
      .filter({ hasText: text })
      .getByRole('checkbox')
      .click()
    const revertSelected = page.getByRole('button', { name: /Revert selected/i })
    await revertSelected.click()
    await page.getByRole('button', { name: 'Revert', exact: true }).click()
    // The selection leaves only once the revert succeeded.
    await expect(revertSelected).toHaveCount(0)

    await openPage(page, 'Getting Started')
    await waitForStableBlockRows(page)
    await expect(page.locator('[data-testid="sortable-block"]', { hasText: text })).toHaveCount(0)
    expect(await blockState(page, created.id)).toBe('deleted')
  })

  test('batch revert restores a deleted block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await waitForStableBlockRows(page)

    const countBefore = await page.locator('[data-testid="sortable-block"]').count()
    expect(countBefore).toBeGreaterThan(0)

    // Delete the first block via the context menu
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await deleteBlockViaContextMenu(page, firstBlock)
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore - 1)

    // Navigate to History
    await navigateToView(page, 'History')
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    // Find and select the delete_block entry
    const deleteEntry = page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('[data-testid="history-type-badge"][data-op-type="delete_block"]'),
      })
      .first()
    await expect(deleteEntry).toBeVisible()
    await deleteEntry.getByRole('checkbox').click()

    // Revert
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await expect(page.getByRole('button', { name: 'Revert', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Revert', exact: true }).click()
    await expect(page.getByText(/^\d+ selected$/)).not.toBeVisible()

    // Navigate back and verify block is restored
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore)
  })

  test('cancel in confirmation dialog does not revert', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await waitForStableBlockRows(page)
    const blocksBefore = await page.locator('[data-testid="sortable-block"]').count()
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(blocksBefore + 1)

    // Navigate to History and select
    await navigateToView(page, 'History')
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })
    await page.locator('[data-history-item]').first().getByRole('checkbox').click()

    // Click revert
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()

    // Cancel
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    // Selection should still be active
    await expect(page.getByText('1 selected')).toBeVisible()
  })

  // Reverting the op chosen, not the newest: a later edit of another block stays.
  test('reverting one edit rolls its block back and keeps a later edit, durably', async ({
    page,
  }) => {
    const [reverted, kept] = [SEED_IDS.BLOCK_GS_1, SEED_IDS.BLOCK_GS_3]
    const before = await storedText(page, reverted)
    await ipc(page, 'edit_block', { blockId: reverted, toText: 'the edit to revert' })
    await ipc(page, 'edit_block', { blockId: kept, toText: 'the edit to keep' })

    await navigateToView(page, 'History')
    await page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('[data-testid="history-type-badge"][data-op-type="edit_block"]'),
      })
      .filter({ hasText: 'the edit to revert' })
      .getByRole('checkbox')
      .click()
    const revertSelected = page.getByRole('button', { name: /Revert selected/i })
    await revertSelected.click()
    await page.getByRole('button', { name: 'Revert', exact: true }).click()
    // The selection leaves only once the revert succeeded.
    await expect(revertSelected).toHaveCount(0)

    await openPage(page, 'Getting Started')
    const row = (id: string) =>
      page.locator(`[data-testid="sortable-block"][data-block-id="${id}"]`)
    await expect(row(reverted)).toHaveText(before)
    await expect(row(kept)).toHaveText('the edit to keep')
    expect(await storedText(page, reverted)).toBe(before)
    expect(await storedText(page, kept)).toBe('the edit to keep')
  })

  // #6051 — reverting a page's delete is refused once a live page of the space
  // holds its title: the toast names the title, and nothing is restored.
  test('reverting a delete onto a taken title says so and restores nothing', async ({ page }) => {
    const title = 'Taken title'
    await navigateToView(page, 'Pages')
    await createPageFromPagesView(page, title)
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Delete page', exact: true }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Delete page', exact: true }).click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')
    await createPageFromPagesView(page, title)

    await navigateToView(page, 'History')
    const deleteEntry = page
      .locator('[data-history-item]')
      .filter({
        has: page.locator('[data-testid="history-type-badge"][data-op-type="delete_block"]'),
      })
      .first()
    await deleteEntry.getByRole('checkbox').click()
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await page.getByRole('button', { name: 'Revert', exact: true }).click()
    await expect(
      page.getByText(`a page titled '${title}' already exists in this space`, { exact: true }),
    ).toBeVisible()

    await navigateToView(page, 'Pages')
    await expect(page.getByRole('grid').getByText(title, { exact: true })).toHaveCount(1)
    await navigateToView(page, 'Trash')
    await expect(page.locator('[data-testid="trash-item"]', { hasText: title })).toHaveCount(1)
  })
})
