import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E for the #1481 task-list editor wiring: pasting a GFM task line into the
 * LIVE editor turns the block into a task (the markdown layer from #1435 is
 * actually wired into paste, not just unit-tested in isolation).
 *
 * What the browser proves that unit tests cannot: a real `paste` ClipboardEvent
 * carrying a `text/plain` DataTransfer, dispatched onto the live contenteditable,
 * is routed through ProseMirror's `handlePaste` (the new `TaskPaste` plugin) and
 * the parsed `todoState` survives the live editor schema (the `TaskParagraph`
 * attr) — rendering as `data-todo-state` on the paragraph. The folding of that
 * marker into the `todo_state` column on blur and the markdown round-trip are
 * covered deterministically by the unit tests (block-utils + markdown
 * serializer + task-paragraph); they are not re-driven here because creating and
 * blurring a brand-new block in the browser races the editor lifecycle.
 *
 * Each test pastes into a FRESH empty block (End → Enter) so the selection is a
 * bare cursor — the condition `TaskPaste` requires (it never overrides a
 * paste-over-selection).
 */

const PAGE = 'Getting Started'

/**
 * `CONTENT_COMMIT_DEBOUNCE_MS` (`src/hooks/useDebouncedContentCommit.ts`) plus
 * headroom. Duplicated as a literal because `e2e/` has no `@/` path mapping;
 * the pause is the SUBJECT of the #4957 case, not a wait for a missing signal.
 */
const PAST_CONTENT_COMMIT_DEBOUNCE_MS = 700 + 500

interface InvokeWindow extends Window {
  __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> }
}

/** Re-read the PERSISTED row for `blockId` straight from the backend. */
async function persistedBlock(
  page: import('@playwright/test').Page,
  blockId: string,
): Promise<{ content: string; todo_state: string | null }> {
  return page.evaluate(async (id) => {
    const invoke = (window as unknown as InvokeWindow).__TAURI_INTERNALS__.invoke
    return (await invoke('get_block', { blockId: id })) as {
      content: string
      todo_state: string | null
    }
  }, blockId)
}

type Editor = import('@playwright/test').Locator

/** Dispatch a native paste of `text/plain` onto the live editor element. */
async function pasteText(editor: Editor, text: string): Promise<void> {
  await editor.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

/** Open a fresh EMPTY block after block 0 and return its live editor locator. */
async function freshBlock(page: import('@playwright/test').Page): Promise<Editor> {
  const editor = await focusBlock(page, 0)
  await editor.press('End')
  await editor.press('Enter')
  const live = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  // The fresh block is an empty paragraph (the editor stamps `is-editor-empty`
  // on the inner <p>); wait for it so the paste lands on a bare cursor.
  await expect(live.locator('p.is-editor-empty')).toBeVisible()
  return live
}

test.describe('Task-list editor paste wiring (#1481)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('pasting "- [ ] task" turns the block into a TODO task', async ({ page }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    await pasteText(editor, '- [ ] paste me')

    // The paragraph becomes a task carrying the live `todoState` attr, and the
    // checkbox marker is consumed (clean task text), not inserted literally.
    await expect(editor.locator('p[data-todo-state="TODO"]')).toBeVisible()
    await expect(editor).toContainText('paste me')
    await expect(editor).not.toContainText('- [ ]')
  })

  test('pasting "- [x] done" turns the block into a DONE task', async ({ page }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    await pasteText(editor, '- [x] finished')

    await expect(editor.locator('p[data-todo-state="DONE"]')).toBeVisible()
    await expect(editor).toContainText('finished')
  })

  test('pasting "- [/] wip" uses the DOING extension marker', async ({ page }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    await pasteText(editor, '- [/] in progress')

    await expect(editor.locator('p[data-todo-state="DOING"]')).toBeVisible()
  })

  /**
   * #4957 — the marker must still fold into `todo_state` when the user PAUSES
   * past the content-commit debounce before saving.
   *
   * The debounced commit used to persist the marker verbatim and rebase the
   * editor's delta baseline (`markCommitted`), so the save's `unmount()`
   * reported no delta and `runUnmountFlush` never reached its checkbox branch:
   * the block kept the literal `- [ ] ` text and `todo_state` stayed null.
   * Nothing above catches that — those cases assert the LIVE paragraph attr
   * right after the paste, never the persisted row after a pause and a save.
   */
  test('a pasted marker still folds into todo_state after the debounce elapses (#4957)', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)
    const blockId = await page
      .locator('[data-testid="block-editor"]')
      .first()
      .getAttribute('data-block-id')
    expect(blockId).not.toBeNull()

    await pasteText(editor, '- [ ] buy milk')
    await expect(editor.locator('p[data-todo-state="TODO"]')).toBeVisible()

    await page.waitForTimeout(PAST_CONTENT_COMMIT_DEBOUNCE_MS)

    // Blur the editor the way clicking away does. NOT `helpers.blurEditors`,
    // whose leading Escape is the DISCARD gesture (`handleEscapeCancel`), and
    // not Enter: with a caret split available `handleEnterSave` commits through
    // `edit()` and never reaches the classifying flush.
    await page.evaluate(() => {
      const el = document.activeElement
      if (el instanceof HTMLElement) el.blur()
    })

    await expect
      .poll(async () => (await persistedBlock(page, blockId as string)).todo_state)
      .toBe('TODO')
    const row = await persistedBlock(page, blockId as string)
    expect(row.content).toBe('buy milk')
  })

  test('pasting normal text does NOT create a task (no regression)', async ({ page }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    await pasteText(editor, 'just ordinary text')

    await expect(editor).toContainText('just ordinary text')
    // The paragraph must NOT gain a task attr — plain paste is untouched.
    await expect(editor.locator('p[data-todo-state]')).toHaveCount(0)
  })

  test('pasting multi-line markdown does NOT become a single task (no regression)', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await freshBlock(page)

    await pasteText(editor, '- [ ] one\n- [ ] two')

    // TaskPaste only acts on a SINGLE task line; multi-line falls through to the
    // default paste (and the flush → splitBlock path), so the block is NOT a
    // single task paragraph carrying a `todoState` attr.
    await expect(editor.locator('p[data-todo-state]')).toHaveCount(0)
  })
})
