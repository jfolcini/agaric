import {
  expect,
  focusBlock,
  installIpcRecorder,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

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

test.describe('Cross-block caret landing @editor', () => {
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

/** Put the live editor's caret at its start or end, past ProseMirror's post-focus sync. */
async function placeCaret(page: import('@playwright/test').Page, at: 'start' | 'end') {
  await page
    .locator('[data-testid="block-editor"] [contenteditable="true"]')
    .evaluate((el, end) => {
      const { editor } = el as HTMLElement & {
        editor: {
          state: { doc: { content: { size: number } } }
          commands: { setTextSelection: (pos: number) => boolean }
        }
      }
      editor.commands.setTextSelection(end ? editor.state.doc.content.size - 1 : 1)
      // ProseMirror writes its selection back 20 ms after a focus; wait past it.
      return new Promise((resolve) => setTimeout(resolve, 20))
    }, at === 'end')
}

test.describe('Typing right after an arrow crosses a block boundary @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  const cases = [
    { key: 'ArrowRight', from: 0, at: 'end' },
    { key: 'ArrowDown', from: 0, at: 'end' },
    { key: 'ArrowLeft', from: 2, at: 'start' },
    { key: 'ArrowUp', from: 2, at: 'start' },
  ] as const

  for (const { key, from, at } of cases) {
    test(`${key} at a block's ${at} keeps the keyboard in the block it lands on`, async ({
      page,
    }) => {
      await openPage(page, PAGE)
      const target = (await renderedBlockIds(page))[1] as string
      const staticTarget = page.locator(`[data-testid="block-static"][data-block-id="${target}"]`)
      const original = (await staticTarget.textContent()) ?? ''

      await focusBlock(page, from)
      await placeCaret(page, at)
      await page.keyboard.press(key)

      const live = page.locator(
        `[data-testid="block-editor"][data-block-id="${target}"] [contenteditable="true"]`,
      )
      await expect(live).toBeFocused()
      await page.keyboard.type('Q')
      await expect(live).toHaveText(`${original}Q`)

      await reopenPage(page, PAGE)
      await expect(staticTarget).toHaveText(`${original}Q`)
    })
  }
})
