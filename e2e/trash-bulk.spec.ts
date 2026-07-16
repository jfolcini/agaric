import {
  activeAlertDialog,
  clearInvokeCalls,
  deleteBlockViaContextMenu,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E tests for Trash bulk operations (#2706).
 *
 * features-coverage.spec.ts's 'Trash' describe covers only single-item
 * restore/purge; keyboard-collisions.spec.ts's 'Trash list-view keyboard
 * selection' describe covers row selection but never fires a batch action.
 * This file covers the remaining #2706 surface: multi-select batch
 * restore/purge, "Restore all" / "Empty trash", and the debounced trash
 * search filter.
 *
 * Unlike the History-view gap (#2705), the mock backs ALL of these flows
 * with real state mutation — `restore_all_deleted` / `purge_all_deleted`
 * (handlers.ts ~2138-2158) and `restore_blocks_by_ids` /
 * `purge_blocks_by_ids` (handlers.ts ~2165-2203) all mutate the shared
 * in-memory `blocks` map, and the TrashView "Restore all" / "Empty trash"
 * header actions actually call `restoreAllDeletedInSpace` /
 * `purgeAllDeletedInSpace` (src/lib/tauri.ts ~475-500), which drain
 * `listTrash` and hand the ids to `restoreBlocksByIds` / `purgeBlocksByIds`
 * — the SAME space-scoped IPCs the batch-toolbar path uses (NOT the
 * unscoped `restore_all_deleted` / `purge_all_deleted` commands — see the
 * #2544 rationale comment on those functions). So every test below
 * asserts genuine end-state (trash list count, restored/purged blocks
 * reappearing or staying gone on their origin page), not just dialog
 * wiring.
 */

test.describe('Trash bulk restore/purge', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('multi-select two roots and batch-restore brings both back', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const countBefore = await page.locator('[data-testid="sortable-block"]').count()

    // Delete two root blocks via the context menu (same path as
    // features-coverage.spec.ts / keyboard-collisions.spec.ts).
    for (let i = 0; i < 2; i++) {
      const row = page.locator('[data-testid="sortable-block"]').first()
      await deleteBlockViaContextMenu(page, row)
    }
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore - 2)

    await page.getByRole('button', { name: /^Trash/ }).click()
    const rows = page.locator('[data-testid="trash-item"]')
    await expect(rows).toHaveCount(2)

    // Select both rows via their checkboxes.
    await rows.nth(0).locator('[data-testid="trash-item-checkbox"]').click()
    await rows.nth(1).locator('[data-testid="trash-item-checkbox"]').click()
    await expect(page.getByText('2 selected')).toBeVisible()

    // Below the 5-item confirmation threshold — restore fires immediately,
    // no confirmation dialog.
    await clearInvokeCalls(page)
    await page.getByTestId('trash-batch-restore-btn').click()

    const calls = await getInvokeCalls(page, 'restore_blocks_by_ids')
    expect(calls).toHaveLength(1)
    const restoredIds = calls[0]?.['blockIds'] as string[] | undefined
    expect(restoredIds?.length).toBe(2)

    await expect(rows).toHaveCount(0)
    await expect(page.getByText('2 blocks restored', { exact: true })).toBeVisible()

    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore)
  })

  test('batch purge shows the non-reversible warning; No leaves items intact, Yes permanently removes them', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const countBefore = await page.locator('[data-testid="sortable-block"]').count()

    for (let i = 0; i < 2; i++) {
      const row = page.locator('[data-testid="sortable-block"]').first()
      await deleteBlockViaContextMenu(page, row)
    }

    await page.getByRole('button', { name: /^Trash/ }).click()
    const rows = page.locator('[data-testid="trash-item"]')
    await expect(rows).toHaveCount(2)

    await rows.nth(0).locator('[data-testid="trash-item-checkbox"]').click()
    await rows.nth(1).locator('[data-testid="trash-item-checkbox"]').click()

    await page.getByTestId('trash-batch-purge-btn').click()
    const dialog = activeAlertDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Permanently delete 2 items?')).toBeVisible()

    // No dismisses without deleting.
    await dialog.getByRole('button', { name: 'No', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(rows).toHaveCount(2)

    // Yes permanently purges the selection.
    await page.getByTestId('trash-batch-purge-btn').click()
    await expect(activeAlertDialog(page)).toBeVisible()
    await clearInvokeCalls(page)
    await activeAlertDialog(page).getByRole('button', { name: 'Yes, delete', exact: true }).click()

    const calls = await getInvokeCalls(page, 'purge_blocks_by_ids')
    expect(calls).toHaveLength(1)
    const purgedIds = calls[0]?.['blockIds'] as string[] | undefined
    expect(purgedIds?.length).toBe(2)
    await expect(rows).toHaveCount(0)

    // Permanently gone, not restored.
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore - 2)
  })

  test('batch-restore confirmation dialog appears above the 5-item threshold', async ({ page }) => {
    // Delete all 5 "Getting Started" blocks + 1 "Quick Notes" block to
    // clear the BATCH_RESTORE_CONFIRM_THRESHOLD (5) — below it batch
    // restore fires immediately (covered by the test above).
    await openPage(page, 'Getting Started')
    for (let i = 0; i < 5; i++) {
      const row = page.locator('[data-testid="sortable-block"]').first()
      await deleteBlockViaContextMenu(page, row)
    }
    await openPage(page, 'Quick Notes')
    await deleteBlockViaContextMenu(page, page.locator('[data-testid="sortable-block"]').first())

    await page.getByRole('button', { name: /^Trash/ }).click()
    const rows = page.locator('[data-testid="trash-item"]')
    await expect(rows).toHaveCount(6)

    // Select one row (reveals the toolbar), then "Select all" for the rest.
    await rows.nth(0).locator('[data-testid="trash-item-checkbox"]').click()
    await page.getByRole('button', { name: 'Select all', exact: true }).click()
    await expect(page.getByText('6 selected')).toBeVisible()

    await page.getByTestId('trash-batch-restore-btn').click()
    const dialog = page.getByTestId('trash-batch-restore-confirm')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Restore 6 items?')).toBeVisible()

    await page.getByTestId('trash-batch-restore-yes').click()
    await expect(dialog).not.toBeVisible()
    await expect(rows).toHaveCount(0)
  })
})

test.describe('Trash — Restore all / Empty trash', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('Empty trash: No leaves items intact, Yes purges everything and zeroes the list', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    const gsCountBefore = await page.locator('[data-testid="sortable-block"]').count()

    for (let i = 0; i < 3; i++) {
      const row = page.locator('[data-testid="sortable-block"]').first()
      await deleteBlockViaContextMenu(page, row)
    }

    await page.getByRole('button', { name: /^Trash/ }).click()
    await expect(page.locator('[data-testid="trash-item"]')).toHaveCount(3)

    await page.getByTestId('trash-empty-trash-btn').click()
    const dialog = activeAlertDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Empty trash?')).toBeVisible()
    await expect(
      dialog.getByText('Permanently delete 3 items? This cannot be undone.'),
    ).toBeVisible()

    // No leaves the trash intact.
    await dialog.getByRole('button', { name: 'No', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('[data-testid="trash-item"]')).toHaveCount(3)

    // Yes empties it.
    await page.getByTestId('trash-empty-trash-btn').click()
    await expect(activeAlertDialog(page)).toBeVisible()
    await clearInvokeCalls(page)
    await activeAlertDialog(page).getByRole('button', { name: 'Yes, delete', exact: true }).click()

    await expect(page.getByText('Nothing in trash. Deleted items will appear here.')).toBeVisible()
    await expect(
      page.getByText('Trash emptied (3 items permanently deleted)', { exact: true }),
    ).toBeVisible()

    const calls = await getInvokeCalls(page, 'purge_blocks_by_ids')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls.flatMap((c) => c['blockIds'] as string[])).toHaveLength(3)

    // Permanently gone, not restored.
    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(gsCountBefore - 3)
  })

  test('Restore all: No leaves items intact, Yes restores everything', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const gsCountBefore = await page.locator('[data-testid="sortable-block"]').count()

    for (let i = 0; i < 2; i++) {
      const row = page.locator('[data-testid="sortable-block"]').first()
      await deleteBlockViaContextMenu(page, row)
    }

    await page.getByRole('button', { name: /^Trash/ }).click()
    await expect(page.locator('[data-testid="trash-item"]')).toHaveCount(2)

    await page.getByTestId('trash-restore-all-btn').click()
    const dialog = activeAlertDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Restore all items?')).toBeVisible()

    // No leaves the trash intact.
    await dialog.getByRole('button', { name: 'No', exact: true }).click()
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('[data-testid="trash-item"]')).toHaveCount(2)

    // Yes restores everything.
    await page.getByTestId('trash-restore-all-btn').click()
    await expect(activeAlertDialog(page)).toBeVisible()
    await clearInvokeCalls(page)
    await activeAlertDialog(page).getByRole('button', { name: 'Restore', exact: true }).click()

    await expect(page.getByText('Nothing in trash. Deleted items will appear here.')).toBeVisible()

    const calls = await getInvokeCalls(page, 'restore_blocks_by_ids')
    expect(calls.length).toBeGreaterThanOrEqual(1)
    expect(calls.flatMap((c) => c['blockIds'] as string[])).toHaveLength(2)

    await openPage(page, 'Getting Started')
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(gsCountBefore)
  })
})

test.describe('Trash search', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('debounced filter narrows the list; clear filter and no-match state work', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    // GS_1 ("Welcome to Agaric! ...") and GS_3 ("Create new blocks ...")
    // are both plain-text seed blocks with distinguishable content.
    const gs1 = page.locator('[data-testid="sortable-block"]', { hasText: 'Welcome to Agaric' })
    const gs3 = page.locator('[data-testid="sortable-block"]', {
      hasText: 'Create new blocks by pressing Enter',
    })
    await deleteBlockViaContextMenu(page, gs1)
    await deleteBlockViaContextMenu(page, gs3)

    await page.getByRole('button', { name: /^Trash/ }).click()
    const rows = page.locator('[data-testid="trash-item"]')
    await expect(rows).toHaveCount(2)

    const filterInput = page.getByTestId('trash-filter-input')
    await filterInput.fill('Welcome')

    // No `waitForTimeout` — Playwright's auto-retrying `expect` absorbs the
    // 300ms debounce (useTrashFilter, src/hooks/useTrashFilter.ts).
    await expect(rows).toHaveCount(1)
    await expect(page.getByTestId('trash-filter-count')).toHaveText('Showing 1 of 2 deleted items')
    await expect(rows.first()).toContainText('Welcome to Agaric')

    // No-match state + its Clear-filter action.
    await filterInput.fill('zzz-no-such-content-zzz')
    await expect(page.getByText('No matching deleted items')).toBeVisible()
    await page.getByTestId('trash-clear-filter-btn').click()
    await expect(filterInput).toHaveValue('')
    await expect(rows).toHaveCount(2)
  })
})
