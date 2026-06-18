/**
 * #1498 — Gutter controls must work while a block's editor is open/focused.
 *
 * The gutter controls (task-state checkbox, collapse caret, priority badge,
 * etc.) live OUTSIDE the block's contenteditable. With the editor focused, a
 * plain click on one of them used to BLUR the ProseMirror editor first; the
 * block then flushed and re-rendered/re-mounted, and the pending `click` event
 * was swallowed — the control did nothing.
 *
 * The fix adds `onMouseDown={(e) => e.preventDefault()}` to each affected
 * gutter button (mirroring the Mermaid node-view toggle, #1438): preventing the
 * mousedown default retains editor focus, so no blur/flush happens and the
 * `onClick` fires while the caret stays in the block.
 *
 * This is a focus-INTERACTION regression that unit tests can miss (jsdom has no
 * real focus/blur/flush pipeline), so we drive it through the live editor:
 * focus a block (cursor inside, editor mounted) and then click its gutter
 * controls and assert the state actually changes.
 */

import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

test.describe('Gutter controls work with the editor open (#1498)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('the gutter task-state checkbox cycles state when clicked with the editor focused', async ({
    page,
  }) => {
    // Open the first block's editor — the cursor is now inside the
    // contenteditable. The gutter task-marker sits OUTSIDE it.
    const editor = await focusBlock(page)
    await expect(editor).toBeFocused()

    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    const taskMarker = firstBlock.locator('[data-testid="task-marker"]')

    // GS_1 has no task state; the block is active (editor open) so the empty
    // checkbox affordance is revealed and hittable.
    await expect(taskMarker).toBeVisible()
    await expect(firstBlock.locator('[data-testid="task-checkbox-todo"]')).toHaveCount(0)

    // THE BUG: with the editor focused, this click does NOTHING — the editor
    // blurs first, the block flushes/re-mounts, and the click is swallowed.
    // WITH THE FIX: mousedown is prevented, the editor keeps focus, the click
    // fires, and the state advances none → TODO
    // (TASK_CYCLE = [null, TODO, DOING, DONE, CANCELLED]).
    await taskMarker.click()
    await expect(firstBlock.locator('[data-testid="task-checkbox-todo"]')).toBeVisible()

    // The editor is still mounted after the click (no flush/remount): the caret
    // stays in the block. This is the other half of the focus-retention contract.
    await expect(editor).toBeVisible()

    // A second click with the editor STILL focused advances TODO → DOING,
    // proving the focus-retention holds across repeated gutter interactions.
    await taskMarker.click()
    await expect(firstBlock.locator('[data-testid="task-checkbox-doing"]')).toBeVisible()
    await expect(editor).toBeVisible()
  })

  test('the gutter priority badge cycles priority when clicked with the editor focused', async ({
    page,
  }) => {
    // Verify a SECOND gutter control behaves the same. Use the seeded "Projects"
    // page: PROJ_1 carries priority '1', so its priority badge renders at rest.
    await openPage(page, 'Projects')

    const proj1 = page.locator('[data-testid="sortable-block"]').first()
    const badge = proj1.locator('[data-testid="priority-badge"]')
    await expect(badge).toBeVisible()
    await expect(badge).toHaveText('P1')

    // Open PROJ_1's editor so the cursor is inside the contenteditable; the
    // priority badge sits OUTSIDE it.
    const editor = await focusBlock(page)
    await expect(editor).toBeFocused()

    // THE BUG: with the editor focused this click would be swallowed. WITH THE
    // FIX: the click cycles the priority P1 → P2 (cycle is [null, 1, 2, 3]) and
    // the editor keeps focus.
    await badge.click()
    await expect(badge).toHaveText('P2')
    await expect(editor).toBeVisible()
  })
})
