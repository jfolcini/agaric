import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeMenu,
  blurEditors,
  deleteBlockViaContextMenu,
  expect,
  focusBlock,
  ipc,
  openPage,
  outlastUndoGroup,
  reopenPage,
  test,
  waitForBoot,
  waitForStableBlockRows,
} from './helpers'

// Block-level undo/redo tests mutate shared mock op-log state
// within a describe, so run them serially to avoid cross-test interference
// even under fullyParallel.
test.describe.configure({ mode: 'serial' })

/**
 * E2E tests for block-level undo/redo (#136).
 *
 * Block-level undo (Ctrl+Z when NOT inside contentEditable) reverses
 * the page's last step through the op log via the useUndoShortcuts
 * hook. Each test reads the stored state back, from the backend and
 * after navigating away and back.
 *
 * Seed data: see `SEED_IDS` in `src/lib/tauri-mock/seed.ts`.
 */

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
const row = (page: Page, blockId: string) =>
  page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)

/** Block `blockId`'s stored text, or `null` once it is deleted (`get_block` refuses it). */
function storedText(page: Page, blockId: string): Promise<string | null> {
  return ipc<{ content: string }>(page, 'get_block', { blockId }).then(
    (block) => block.content,
    () => null,
  )
}

async function storedTodo(page: Page, blockId: string): Promise<string | null> {
  return (await ipc<{ todo_state: string | null }>(page, 'get_block', { blockId })).todo_state
}

/** Open Getting Started once its rows have rendered, so a count read of them is whole. */
async function openGettingStarted(page: Page): Promise<void> {
  await openPage(page, 'Getting Started')
  await waitForStableBlockRows(page)
}

/** Press a page undo or redo chord and wait for its toast: a press while one runs is dropped. */
async function pageHistory(page: Page, chord: string, toast: string | RegExp): Promise<void> {
  await page.keyboard.press(chord)
  await expect(page.getByLabel('Notifications alt+T').getByText(toast)).toBeVisible()
}

/**
 * Add a block at the end of the page and type `text` into it; resolves to its id. An empty block
 * is deleted once it loses focus, so the create alone leaves nothing to undo. The text is typed
 * once the create's undo step has closed, `UNDO_GROUP_WINDOW_MS` after it landed, so the create
 * and the text are a page step each.
 */
async function addTypedBlock(page: Page, text: string): Promise<string> {
  await page.getByRole('button', { name: 'Add block' }).click()
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toBeFocused()
  const id = await editor.evaluate(
    (el) => el.closest('[data-testid="sortable-block"]')?.getAttribute('data-block-id') ?? '',
  )
  await expect.poll(() => storedText(page, id)).toBe('')
  await outlastUndoGroup()
  await page.keyboard.type(text)
  await blurEditors(page)
  await expect.poll(() => storedText(page, id)).toBe(text)
  return id
}

/** Set block `blockId` as a task from its block menu. */
async function setTodoFromMenu(page: Page, blockId: string): Promise<void> {
  await row(page, blockId).click({ button: 'right' })
  await activeMenu(page).getByRole('menuitem', { name: 'Set as TODO' }).click()
  await expect.poll(() => storedTodo(page, blockId)).toBe('TODO')
}

test.describe('Block-level undo/redo @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('undo reverses block creation', async ({ page }) => {
    await openGettingStarted(page)
    const countBefore = await rows(page).count()
    const id = await addTypedBlock(page, 'added then undone')
    await expect(rows(page)).toHaveCount(countBefore + 1)

    // The first press takes back the text, the second the block.
    await pageHistory(page, 'Control+z', 'Undid edit')
    await expect.poll(() => storedText(page, id)).toBe('')
    await pageHistory(page, 'Control+z', 'Undid create block')
    await expect.poll(() => storedText(page, id)).toBeNull()

    await reopenPage(page, 'Getting Started')
    await expect(rows(page)).toHaveCount(countBefore)
  })

  test('undo reverses block deletion', async ({ page }) => {
    await openGettingStarted(page)

    const countBefore = await page.locator('[data-testid="sortable-block"]').count()
    expect(countBefore).toBeGreaterThan(0)

    // Delete the first block via the context menu
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await deleteBlockViaContextMenu(page, firstBlock)

    // Verify block was deleted
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore - 1)

    // Escape and blur out of any contentEditable
    await blurEditors(page)

    // Press Ctrl+Z — triggers block-level undo
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()

    // Navigate away and back to re-fetch from the backend
    await reopenPage(page, 'Getting Started')

    // Block count should be restored
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(countBefore)
  })

  test('redo re-applies after undo', async ({ page }) => {
    await openGettingStarted(page)
    const countBefore = await rows(page).count()
    const id = await addTypedBlock(page, 'added, undone and redone')
    await pageHistory(page, 'Control+z', 'Undid edit')
    await pageHistory(page, 'Control+z', 'Undid create block')
    await expect.poll(() => storedText(page, id)).toBeNull()

    await pageHistory(page, 'Control+y', /^Redid /)
    await expect.poll(() => storedText(page, id)).toBe('')
    await pageHistory(page, 'Control+y', 'Redid edit')
    await expect.poll(() => storedText(page, id)).toBe('added, undone and redone')

    await reopenPage(page, 'Getting Started')
    await expect(rows(page)).toHaveCount(countBefore + 1)
    await expect(rows(page).last()).toHaveText('added, undone and redone')
  })

  // The block menu's "Set as TODO" is one `set_todo_state`, which the page's undo reverses
  // through the op log. Each state is read back from the backend and again after a reopen.
  test('Ctrl+Z clears the task state the block menu set, durably', async ({ page }) => {
    await openGettingStarted(page)
    const gs3 = SEED_IDS.BLOCK_GS_3
    const marker = row(page, gs3).getByTestId('task-marker')
    await setTodoFromMenu(page, gs3)
    await expect(marker).toBeVisible()

    await pageHistory(page, 'Control+z', 'Undid property change')
    await expect.poll(() => storedTodo(page, gs3)).toBeNull()
    await expect(marker).toHaveCount(0)

    await reopenPage(page, 'Getting Started')
    await expect(row(page, gs3)).toBeVisible()
    await expect(marker).toHaveCount(0)
    expect(await storedTodo(page, gs3)).toBeNull()
  })

  test('Ctrl+Y sets back the task state Ctrl+Z cleared, durably', async ({ page }) => {
    await openGettingStarted(page)
    const gs3 = SEED_IDS.BLOCK_GS_3
    const marker = row(page, gs3).getByTestId('task-marker')
    await setTodoFromMenu(page, gs3)
    await pageHistory(page, 'Control+z', 'Undid property change')
    await expect.poll(() => storedTodo(page, gs3)).toBeNull()

    await pageHistory(page, 'Control+y', 'Redid property change')
    await expect.poll(() => storedTodo(page, gs3)).toBe('TODO')
    await expect(marker).toBeVisible()

    await reopenPage(page, 'Getting Started')
    await expect(marker).toBeVisible()
    expect(await storedTodo(page, gs3)).toBe('TODO')
  })

  // ===========================================================================
  // Structural undo/redo (#922 f5).
  //
  // The three tests above cover block CREATE / DELETE only — flat-list ops
  // whose visible effect is a count change. They also lean on the
  // navigate-away-and-back `reopenPage` re-fetch to observe the post-undo
  // state.
  //
  // These tests cover the STRUCTURAL ops (indent / dedent / move) and, per
  // the finding, assert the block returns to its original depth/order
  // *IN PLACE* — without reopening — which is what exercises the
  // `refreshAfterUndoRedo` reload path in `useUndoShortcuts`: after Ctrl+Z
  // the hook calls `pageBlockRegistry.get(pageId).load()`, re-projecting the
  // current tree into the live store so the DOM updates without a view swap.
  //
  // Indent / dedent / move all emit a `move_block` op (the indent shortcut
  // re-parents the block under its previous sibling), so the undo path is the
  // same `move_block` reversal for all three. We assert on the structural
  // signal (paddingLeft for depth, `data-block-id` order for moves) rather
  // than the toast: the toast text is now per-op-type ("Undid move"), so the
  // structural signal is the more direct assertion of what actually changed.
  //
  // Redo uses Ctrl+Shift+Z (one of the two `redoLastUndoneOp` bindings, the
  // other being Ctrl+Y used by the create test above) to cover that chord too.
  // ===========================================================================

  test('undo/redo an indent reverts depth in place (no reopen)', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // GS_3 (index 2) is plain text — avoids the link chips in GS_2.
    const targetBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const basePadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // Indent GS_3 under GS_2 via the documented Ctrl+Shift+ArrowRight shortcut.
    await focusBlock(page, 2)
    await page.keyboard.press('Control+Shift+ArrowRight')

    // Confirm the indent applied (paddingLeft grew).
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBeGreaterThan(basePadding)
    const indentedPadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // Escape out of the editor so Ctrl+Z hits useUndoShortcuts (not ProseMirror).
    await blurEditors(page)

    // Ctrl+Z — block-level undo. Reverses the move_block op AND, crucially,
    // calls refreshAfterUndoRedo → the store reloads and the depth reverts
    // IN PLACE with no navigation.
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()

    // WITHOUT reopening: the block must be back at its original depth.
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(basePadding)

    // Ctrl+Shift+Z — redo re-applies the indent, again in place.
    await page.keyboard.press('Control+Shift+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Red(one|id)/)).toBeVisible()
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(indentedPadding)
  })

  // #958: undoing a dedent must re-nest the block to its prior depth IN PLACE
  // (no reopen). The indent here is only scaffolding to create a depth to dedent
  // FROM; it must NOT be part of the same undo group as the dedent, or the single
  // Ctrl+Z reverts BOTH (indent + dedent are both `move_block` by the same device,
  // and undo batches same-device ops within UNDO_GROUP_WINDOW_MS=500ms — see
  // undo.ts / undo_page_group). The earlier "depth stays 0" trace failure was
  // exactly that group: undo reverted the dedent AND the scaffolding indent, so
  // the block landed back at root. Waiting past the 500ms window puts the dedent
  // in its own undo group, so Ctrl+Z reverts only the dedent.
  test('undo a dedent restores the nested depth in place (no reopen)', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const targetBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const basePadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // First indent GS_3 so there is a depth to dedent FROM (editor stays open).
    await focusBlock(page, 2)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBeGreaterThan(basePadding)
    const indentedPadding = Number.parseInt(
      await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
      10,
    )

    // Let the undo-group window lapse after the indent has landed (the padding
    // above is optimistic), so the scaffolding indent and the dedent below are
    // SEPARATE undo groups — otherwise one Ctrl+Z reverts both.
    await expect
      .poll(
        async () =>
          (
            await ipc<{ parent_id: string | null }>(page, 'get_block', {
              blockId: SEED_IDS.BLOCK_GS_3,
            })
          ).parent_id,
      )
      .toBe(SEED_IDS.BLOCK_GS_2)
    await outlastUndoGroup()

    // Dedent it back to root (Ctrl+Shift+ArrowLeft); editor is still open.
    await page.keyboard.press('Control+Shift+ArrowLeft')
    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(basePadding)

    // Escape and undo the dedent — depth must return to the INDENTED value in
    // place (the dedent was the last op; its reversal re-nests the block).
    await blurEditors(page)
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()

    await expect
      .poll(async () =>
        Number.parseInt(
          await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft),
          10,
        ),
      )
      .toBe(indentedPadding)
  })

  // #958: a single keyboard move (Ctrl+Shift+ArrowUp) is its own undo group, so
  // Ctrl+Z reverts exactly that move in place (no reopen). Confirmed green e2e
  // after the tauri-mock move undo/redo re-slot+renumber fix (undo-move.test.ts).
  test('undo/redo a move reverts block order in place (no reopen)', async ({ page }) => {
    // Quick Notes has exactly 2 blocks — the simplest, most reliable move case.
    await openPage(page, 'Quick Notes')

    const blocks = page.locator('[data-testid="sortable-block"]')
    const originalFirstId = (await blocks.nth(0).getAttribute('data-block-id')) ?? ''
    const originalSecondId = (await blocks.nth(1).getAttribute('data-block-id')) ?? ''
    expect(originalFirstId).not.toBe('')
    expect(originalSecondId).not.toBe('')

    // Move the second block up (Ctrl+Shift+ArrowUp) so the order swaps.
    await focusBlock(page, 1)
    await page.keyboard.press('Control+Shift+ArrowUp')

    // Escape so the move settles and the next Ctrl+Z hits useUndoShortcuts.
    await blurEditors(page)

    // The previously-second block is now first.
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalSecondId, {
      timeout: 5000,
    })

    // Ctrl+Z — undo the move. Order must revert IN PLACE (no reopen): the
    // original first block is first again.
    await page.keyboard.press('Control+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Und(one|id)/)).toBeVisible()
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalFirstId, {
      timeout: 5000,
    })

    // Ctrl+Shift+Z — redo re-applies the move, again in place.
    await page.keyboard.press('Control+Shift+z')
    await expect(page.getByLabel('Notifications alt+T').getByText(/Red(one|id)/)).toBeVisible()
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalSecondId, {
      timeout: 5000,
    })
  })
})
