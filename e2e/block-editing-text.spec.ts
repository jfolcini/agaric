import { expect, focusBlock, installIpcRecorder, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for cross-block caret landing (#911). The two *mobile* search specs and
 * the existing keyboard specs never assert that an arrow key at a block
 * boundary lands focus on the ADJACENT block — keyboard-shortcuts.spec.ts only
 * checks that focus changed, not the direction. These specs assert direction.
 *
 * (Enter-split is covered in block-keyboard-fundamentals.spec.ts. Backspace-at-
 * start MERGE-text is covered by the handleMergeWithPrev unit tests in
 * src/hooks/__tests__/useBlockKeyboardHandlers.test.ts — an e2e for it is
 * intentionally omitted: the merge fires off ProseMirror's internal selection,
 * which can briefly lag the DOM selection an e2e can observe, making any
 * caret-at-start precondition non-deterministic from outside the editor.)
 */

const PAGE = 'Getting Started'

async function liveEditorBlockId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.locator('[data-testid="block-editor"]').first().getAttribute('data-block-id')
}

async function renderedBlockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

test.describe('Cross-block caret landing', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('ArrowDown at the end of a block moves focus to the NEXT block', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await renderedBlockIds(page)

    const editor = await focusBlock(page, 0)
    const startId = await liveEditorBlockId(page)
    expect(startId).toBe(ids[0])
    await editor.press('End')
    await editor.press('ArrowDown')

    // Focus lands specifically on the next sibling (ids[1]), not just "different".
    await expect.poll(async () => liveEditorBlockId(page)).toBe(ids[1])
  })

  test('ArrowDown then ArrowDown walks focus down two blocks in order', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await renderedBlockIds(page)

    const editor = await focusBlock(page, 0)
    await editor.press('End')
    await editor.press('ArrowDown')
    await expect.poll(async () => liveEditorBlockId(page)).toBe(ids[1])

    // Continue down: End (now on block 1) → ArrowDown lands on block 2.
    const live = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await live.press('End')
    await live.press('ArrowDown')
    await expect.poll(async () => liveEditorBlockId(page)).toBe(ids[2])
  })
})
