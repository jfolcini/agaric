import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for Shift+Arrow range selection when an ANCESTOR COLLAPSES (#976
 * finding 5).
 *
 * `extendSelection` is unit-tested with visibility checks (clamping / visible
 * filtering / unchanged-state return when anchor/focus go invisible), but the
 * existing `e2e/block-keyboard-select.spec.ts` only covers basic down-extend
 * and up-shrink — never the collapse-during-selection scenario. This spec
 * closes that gap end-to-end:
 *
 *   1. build a parent (GS_1) with a child (GS_2) by indenting GS_2;
 *   2. enter block-select mode and Shift+ArrowDown to build a contiguous range
 *      that INCLUDES the child GS_2;
 *   3. collapse GS_1, making the selected child GS_2 invisible;
 *   4. press Shift+ArrowDown again and assert the selection/anchor/focus stay
 *      VALID or degrade GRACEFULLY (no crash, no console error — the global
 *      console-error watcher enforces that — and the batch toolbar count stays
 *      consistent with the still-visible selection).
 *
 * Seed: "Getting Started" → GS_1…GS_5 (flat); nesting is built at runtime.
 */

const PAGE = 'Getting Started'

test.describe('Keyboard range selection across an ancestor collapse (#922)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('Shift+Arrow selection with a collapsing ancestor preserves the range gracefully', async ({
    page,
  }) => {
    const blocks = page.locator('[data-testid="sortable-block"]')
    const batchToolbar = page.getByTestId('batch-toolbar')

    // Capture GS_1 (parent-to-be) and GS_2 (child-to-be) ids UP FRONT. Once GS_1
    // collapses, GS_2's row leaves the DOM and positional `nth()` locators shift
    // (nth(1) would then resolve to GS_3), so we must target GS_2 by id.
    const ids = await blocks.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-block-id') ?? ''),
    )
    const gs2 = ids[1] as string
    const childById = page.locator(
      `[data-testid="sortable-block"][data-block-id="${gs2}"] [data-testid="block-static"]`,
    )

    // 1. Indent GS_2 (index 1) under GS_1 (index 0) so GS_1 becomes a parent
    //    with one child. GS_2 is now nested.
    await focusBlock(page, 1)
    await page.keyboard.press('Control+Shift+ArrowRight')
    // GS_1 now owns a collapse chevron (hasChildren).
    const parentRow = blocks.nth(0)
    const chevron = parentRow.locator('[data-testid="collapse-toggle"]')
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')

    // Leave editor focus so the Ctrl+Click / Shift+Arrow chords drive
    // BLOCK-select mode (not in-editor text selection).
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="block-editor"]')).not.toBeVisible()

    // 2. Anchor the selection on the CHILD (GS_2) via Ctrl+Click, then
    //    Shift+ArrowDown to extend the range down to the next visible block
    //    (GS_3). The selection now includes the nested child GS_2.
    await childById.click({ modifiers: ['Control'] })
    await expect(childById).toHaveClass(/block-selected/)
    await expect(batchToolbar).toContainText('1')

    await page.keyboard.press('Shift+ArrowDown')
    await expect(batchToolbar).toContainText('2')

    // 3. Collapse GS_1 — the selected child GS_2 becomes invisible (its row is
    //    filtered out of the visible list). #1243: the EXPANDED chevron is
    //    hover-revealed (pointer-events-none at rest), so hover the row first
    //    to make it actionable. (The later expand-click works without a hover —
    //    a COLLAPSED chevron stays visible/interactive at rest.)
    await parentRow.hover()
    await chevron.click()
    await expect(chevron).toHaveAttribute('aria-expanded', 'false')
    // GS_2's static row (targeted by id) is gone from the collapsed-visible tree.
    await expect(childById).toHaveCount(0)

    // 4. Press Shift+ArrowDown again with a selected-but-invisible block in the
    //    range. The implementation must NOT crash and must degrade gracefully:
    //    it re-anchors to a still-visible selected block or no-ops per the
    //    visibility clamps. We assert the app stays alive and interactive — the
    //    batch toolbar is still mounted with a positive, sane count — and the
    //    global console-error watcher (helpers.afterEach) catches any thrown
    //    error from the selection math.
    await page.keyboard.press('Shift+ArrowDown')

    await expect(batchToolbar).toBeVisible()
    const countText = await batchToolbar.textContent()
    const count = Number(countText?.match(/\d+/)?.[0] ?? '0')
    // At least one block stays selected (graceful degradation never empties a
    // non-empty selection), and the count never exceeds the four currently
    // visible rows (GS_1, GS_3, GS_4, GS_5 — GS_2 is hidden under GS_1).
    expect(count).toBeGreaterThanOrEqual(1)
    expect(count).toBeLessThanOrEqual(4)

    // The page is still interactive: expanding GS_1 restores the child row,
    // proving the collapse + selection chord left the tree in a consistent
    // state rather than a wedged one.
    await chevron.click()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')
    await expect(childById).toBeVisible()
  })
})
