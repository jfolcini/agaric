/**
 * #4551 — the linked-references panel retargets onto the zoomed block.
 *
 * At the page root the panel lists what points at the PAGE. Zoom into a block
 * and it lists what points at that BLOCK — the two sets are disjoint here, so
 * the spec can tell them apart by the row text alone rather than by counting.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`):
 *   - QN_1, on "Quick Notes", carries `[[PAGE_GETTING_STARTED]]` — the page's
 *     own backlink, visible at the page root.
 *   - The test adds `((GS_1))` to QN_2, so the FIRST block of "Getting
 *     Started" has a backlink of its own, visible only while zoomed into it.
 *
 * The retarget is UI-only (`PageEditor` lifts `zoomedBlockId` out of
 * `BlockTree` through `onZoomChange` and hands it to `LinkedReferences` as
 * `targetId`), so it belongs in this mock-backed lane; the backend half —
 * `list_backlinks_grouped` answering for a block id, and the `kind` filter —
 * is pinned by `conformance/fixtures/block_ref_kind.json`.
 */

import {
  activeMenu,
  activeSuggestionList,
  expect,
  focusBlock,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

const REFERENCES = '[data-testid="linked-references"]'

test.describe('Linked references follow the zoom', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('zooming into a block retargets the references panel, zooming out restores it', async ({
    page,
  }) => {
    // 1. Give GS_1 a backlink of its own: a `((GS_1))` reference from QN_2, on
    //    a different page (a same-page source would be excluded as a
    //    self-reference).
    await openPage(page, 'Quick Notes')
    await focusBlock(page, 1)
    await page.keyboard.press('End')
    await page.keyboard.type(' ((Welcome', { delay: 30 })
    const suggestions = activeSuggestionList(page)
    await expect(suggestions.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
    await page.keyboard.press('Enter')
    const chip = page.locator('[data-testid="block-ref-chip"]').first()
    await expect(chip).toBeVisible()
    // The picker searches block CONTENT, and only GS_1 says "Welcome" — but
    // assert it rather than assume, because the zoom target below is that
    // exact block.
    const targetId = await chip.getAttribute('data-id')
    // Enter, not Escape: Escape DISCARDS the draft here (it fires
    // `delete_draft` and no `edit_block`), so the reference would never reach
    // the mock's block_links derivation and every assertion below would be
    // vacuous.
    await saveBlock(page, 'Enter')

    // 2. At the page root the panel lists the PAGE's backlinks: QN_1.
    await openPage(page, 'Getting Started')
    const references = page.locator(REFERENCES)
    await expect(references).toContainText('These notes complement the')
    await expect(references).not.toContainText('Jot down quick thoughts')

    // 3. Zoom into GS_1. Escape first so the context menu lands on the block
    //    wrapper rather than on a focused ProseMirror surface.
    await page.keyboard.press('Escape')
    await page
      .locator(`[data-testid="sortable-block"][data-block-id="${targetId}"]`)
      .click({ button: 'right' })
    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Zoom in' }).click()
    await expect(page.getByRole('navigation', { name: /zoom breadcrumbs/i })).toBeVisible()

    // The panel now answers for the BLOCK: QN_2's reference, not QN_1's page
    // link. Both rows live on the same source page, so a panel that had merely
    // kept showing the page's backlinks would still read "Quick Notes".
    await expect(references).toContainText('Jot down quick thoughts')
    await expect(references).not.toContainText('These notes complement the')

    // 4. Zoom back out — the page's own references return.
    await page.getByRole('button', { name: 'Exit zoom' }).click()
    await expect(references).toContainText('These notes complement the')
    await expect(references).not.toContainText('Jot down quick thoughts')
  })
})
