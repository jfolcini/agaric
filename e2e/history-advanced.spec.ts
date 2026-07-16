import {
  activeAlertDialog,
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

// Same risk profile as history-revert.spec.ts (shared mock op-log mutated
// and asserted within a describe) — run serially to avoid interleaving
// under fullyParallel.
test.describe.configure({ mode: 'serial' })

/**
 * E2E tests for HistoryView surfaces beyond batch revert (#2705).
 *
 * history-revert.spec.ts covers only multi-select batch revert. This file
 * extends coverage to 'Restore to here', the word-level diff toggle, the
 * op-type filter / "All spaces" toggle, and the op-log compaction card —
 * to the extent the tauri-mock supports each.
 *
 * Mock-blocked flows (documented here, NOT faked as passing coverage):
 *
 *  - `restore_page_to_op` (src/lib/tauri-mock/handlers.ts ~4587) is a
 *    hardcoded stub: `() => ({ ops_reverted: 0, non_reversible_skipped: 0,
 *    results: [] })`. It ignores its arguments entirely and never mutates
 *    `blocks` / `opLog`. The tests below assert the confirmation dialog,
 *    the cancel path, and the exact wire args of the `restore_page_to_op`
 *    IPC call — but cannot assert that page content rolls back to the
 *    historical snapshot, since the mock has no such behavior to exercise.
 *
 *  - `list_page_history` (handlers.ts ~2554-2595) reads `args.scope` (space
 *    scoping) but never reads `args.opTypeFilter` — op-type filtering is
 *    NOT applied mock-side, only real-backend-side
 *    (src-tauri/agaric-store/src/pagination/history.rs). The filter-bar test below
 *    asserts the Select's WIRING (the chosen op type reaches the
 *    `list_page_history` IPC call), not that the rendered list narrows,
 *    since the mock always returns the full unfiltered set regardless of
 *    the filter value.
 *
 *  - `get_compaction_status`'s `eligible_ops` and `compact_op_log_cmd`'s
 *    `ops_deleted` (handlers.ts ~4574-4581) are both hardcoded to 0 /
 *    `{ ops_deleted: 0 }` — compaction never actually removes anything from
 *    the mock's `opLog`. The compaction test asserts the card renders the
 *    live `total_ops` count, opens the confirm dialog, and fires
 *    `compact_op_log_cmd` — not that `total_ops` decreases afterward.
 *
 *  - There is no separate "user vs agent" or "date range" filter control in
 *    `HistoryFilterBar` today (only the op-type Select + the "All spaces"
 *    toggle) — a per-row `is_replicated` badge exists, but it is not
 *    wired to a filter. Nothing to test there beyond what's covered below.
 */

test.describe('HistoryView — restore to here', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('confirmation dialog shows and Cancel leaves state intact', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    await page.getByRole('button', { name: 'History', exact: true }).click()
    const firstItem = page.locator('[data-history-item]').first()
    await expect(firstItem).toBeVisible({ timeout: 5000 })

    await clearInvokeCalls(page)
    await firstItem.locator('.restore-to-here-btn').click()

    // Confirmation dialog appears with the restore-to timestamp copy.
    await expect(activeAlertDialog(page)).toBeVisible()
    await expect(page.getByText(/^Restore to .+\?$/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()

    // Cancel dismisses without calling the IPC.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(activeAlertDialog(page)).not.toBeVisible()
    expect(await getInvokeCalls(page, 'restore_page_to_op')).toHaveLength(0)
  })

  test('confirming fires restore_page_to_op with the entry target and shows a toast', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    await page.getByRole('button', { name: 'History', exact: true }).click()
    const firstItem = page.locator('[data-history-item]').first()
    await expect(firstItem).toBeVisible({ timeout: 5000 })

    // Extract the entry's seq from the checkbox's accessible name
    // ("Select operation create_block #<seq>") so we can assert the
    // exact wire args below without hardcoding a seq value.
    const checkboxLabel = await firstItem
      .locator('input[type="checkbox"]')
      .getAttribute('aria-label')
    const seqMatch = checkboxLabel?.match(/#(\d+)/)
    expect(seqMatch).not.toBeNull()
    const expectedSeq = Number(seqMatch?.[1])

    await clearInvokeCalls(page)
    await firstItem.locator('.restore-to-here-btn').click()
    await expect(activeAlertDialog(page)).toBeVisible()
    await page.getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(activeAlertDialog(page)).not.toBeVisible()

    const calls = await getInvokeCalls(page, 'restore_page_to_op')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.['pageId']).toBe('__all__')
    expect(calls[0]?.['targetSeq']).toBe(expectedSeq)
    expect(typeof calls[0]?.['targetDeviceId']).toBe('string')

    // Mock's restore_page_to_op is a hardcoded stub returning
    // ops_reverted: 0 (handlers.ts ~4587) — the toast reflects that,
    // not a real rollback count.
    await expect(page.getByText('0 operations reverted successfully')).toBeVisible()
  })
})

test.describe('HistoryView — diff toggle', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('diff toggle renders word-level insert/delete for an edit_block entry', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page, 0)
    await editor.press('Control+a')
    await editor.pressSequentially('Updated welcome message')
    // Commit via blur (clicking the page title), NOT Enter (which splits
    // off a trailing empty block and would push a `create_block` op ahead
    // of the `edit_block` we want at index 0) or Escape (which discards
    // the edit — `onEscapeCancel` in src/editor/use-block-keyboard.ts).
    await page.locator('[aria-label="Page title"]').click()
    await expect(page.locator('[data-testid="block-static"]').first()).toContainText(
      'Updated welcome message',
    )

    await page.getByRole('button', { name: 'History', exact: true }).click()
    const firstItem = page.locator('[data-history-item]').first()
    await expect(firstItem).toBeVisible({ timeout: 5000 })
    await expect(
      firstItem.locator('[data-testid="history-type-badge"]', { hasText: 'edit_block' }),
    ).toBeVisible()

    await firstItem.getByRole('button', { name: 'Diff' }).click()

    const diffRegion = firstItem.locator('section[aria-label="Diff content"]')
    await expect(diffRegion).toBeVisible()
    await expect(diffRegion.locator('ins')).toContainText('Updated welcome message')
    await expect(diffRegion.locator('del')).toContainText(
      'Welcome to Agaric! This is your personal knowledge base.',
    )
  })
})

test.describe('HistoryView — filter bar', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('op type Select fires list_page_history with the chosen opTypeFilter', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    await page.getByRole('button', { name: 'History', exact: true }).click()
    await expect(page.locator('[data-history-item]').first()).toBeVisible({ timeout: 5000 })

    await clearInvokeCalls(page)
    await page.getByRole('combobox', { name: 'Filter by operation type' }).click()
    await page.getByRole('option', { name: 'Create' }).click()

    // Wiring: the correct opTypeFilter reaches the IPC. (The mock ignores
    // it — see spec header — so the rendered list is NOT asserted to
    // narrow here.)
    await expect
      .poll(async () => {
        const calls = await getInvokeCalls(page, 'list_page_history')
        return calls.at(-1)?.['opTypeFilter'] ?? null
      })
      .toBe('create_block')

    // The ✕ clear-filter control resets the Select and the IPC arg.
    await expect(page.getByTestId('history-filter-clear')).toBeVisible()
    await clearInvokeCalls(page)
    await page.getByTestId('history-filter-clear').click()
    await expect
      .poll(async () => {
        const calls = await getInvokeCalls(page, 'list_page_history')
        return calls.length > 0 ? (calls.at(-1)?.['opTypeFilter'] ?? null) : undefined
      })
      .toBe(null)
  })

  test('"All spaces" toggle switches the list_page_history scope', async ({ page }) => {
    await page.getByRole('button', { name: 'History', exact: true }).click()
    await expect(page.getByTestId('history-all-spaces-toggle')).toBeVisible()

    await clearInvokeCalls(page)
    await page.getByTestId('history-all-spaces-toggle').click()

    await expect
      .poll(async () => {
        const calls = await getInvokeCalls(page, 'list_page_history')
        const scope = calls.at(-1)?.['scope'] as { kind?: string } | undefined
        return scope?.kind ?? null
      })
      .toBe('global')
  })
})

test.describe('HistoryView — op log compaction', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('compaction card shows live total ops and Compact Now fires compact_op_log_cmd', async ({
    page,
  }) => {
    // Generate at least one op so `total_ops` (real/stateful in the mock)
    // is non-zero.
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]').last()).toBeVisible()

    await page.getByRole('button', { name: 'History', exact: true }).click()
    await page.getByRole('button', { name: 'Op Log Compaction' }).click()

    const totalOps = page.getByTestId('compaction-total-ops')
    await expect(totalOps).toBeVisible()
    await expect(totalOps).not.toHaveText('0')

    await clearInvokeCalls(page)
    await page.getByRole('button', { name: 'Compact Now' }).click()
    await expect(activeAlertDialog(page)).toBeVisible()
    await expect(page.getByText('Compact Op Log?')).toBeVisible()

    await page.getByRole('button', { name: 'Compact', exact: true }).click()
    await expect(activeAlertDialog(page)).not.toBeVisible()

    expect(await getInvokeCalls(page, 'compact_op_log_cmd')).toHaveLength(1)
    // Mock's compact_op_log_cmd is a hardcoded stub returning
    // ops_deleted: 0 (handlers.ts ~4581) — total_ops does NOT decrease
    // after this call, so that is not asserted here.
    await expect(page.getByText('Compacted 0 operations')).toBeVisible()
  })
})
