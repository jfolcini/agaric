import {
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for the keyboard FUNDAMENTALS surfaced by the 2026-06-11 UX review:
 *
 *   - #909 Enter splits the block at the caret (before-text stays, after-text
 *     seeds the new block) — previously Enter always created an EMPTY block and
 *     stranded the text after the caret.
 *   - #912 Tab / Shift+Tab indent / dedent (the universal outliner key) —
 *     previously Tab was unbound for block restructure.
 *   - #910 Shift+Arrow at a block boundary extends the selection instead of
 *     navigating to the adjacent block and dropping it.
 *
 * As with block-keyboard-move.spec.ts, assertions are made primarily on the
 * recorded IPC payloads (`create_block` / `edit_block` / `move_block`) rather
 * than the mock backend's reconciled visual order — the slot/content the UI
 * *sends* is the deterministic signal.
 */

const PAGE = 'Getting Started'

async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

/** Most recent recorded payload for a command, or null. */
async function lastCall(
  page: import('@playwright/test').Page,
  cmd: string,
): Promise<Record<string, unknown> | null> {
  const calls = await getInvokeCalls(page, cmd)
  return (calls[calls.length - 1] as Record<string, unknown>) ?? null
}

test.describe('Keyboard fundamentals', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  // ── #909 Enter splits at the caret ──────────────────────────────────────

  test('Enter splits the block at the caret: before-text stays, after-text moves down', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 0)

    // Build "helloworld" with the caret deterministically BETWEEN the two
    // halves, then split there. The original recipe typed "world", pressed
    // Home, then typed "hello" — but Home is itself a caret-move transaction
    // that must COMMIT before the next keystroke types. Under the static
    // `vite preview` build's tighter timing and the 2-worker shard load in CI,
    // the caret had sometimes not collapsed to the start before "hello" typed
    // (or Home was dropped on a focus hiccup), so the text landed at the end
    // and produced "worldhello" instead of "helloworld" — failing the split
    // and flaking `playwright (1)` on BE-only PRs once #1458 moved e2e onto
    // the preview build.
    //
    // Make it deterministic: type the WHOLE word in one go (no mid-stream
    // caret move to race), confirm it committed, then drive the caret to the
    // split point with ArrowLeft and poll the DOM selection until it is
    // actually collapsed at offset 5 ("hello|world") before pressing Enter.
    await editor.press('Control+a')
    await editor.pressSequentially('helloworld')
    // Sync point: the full text has committed before we move the caret.
    await expect(editor).toHaveText('helloworld')
    // Drive the caret to sit between "hello" and "world" (offset 5). Re-press
    // ArrowLeft from the end until the selection is collapsed exactly there,
    // so the split position never depends on a single keystroke winning a race.
    await editor.press('End')
    await expect
      .poll(async () => {
        const offset = await page.evaluate(() => {
          const sel = window.getSelection()
          return sel !== null && sel.isCollapsed ? sel.anchorOffset : -1
        })
        if (offset > 5) {
          await editor.press('ArrowLeft')
        }
        return offset
      })
      .toBe(5)

    await clearInvokeCalls(page)
    await editor.press('Enter')

    // The current block is edited down to the before-caret text…
    await expect.poll(async () => (await lastCall(page, 'edit_block'))?.toText).toBe('hello')
    // …and a new block is created WITH the after-caret text.
    await expect.poll(async () => (await lastCall(page, 'create_block'))?.content).toBe('world')
  })

  test('Enter at the end of a block creates an EMPTY block below', async ({ page }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 0)

    await editor.press('Control+a')
    await editor.pressSequentially('hello')
    await editor.press('End')

    await clearInvokeCalls(page)
    await editor.press('Enter')

    await expect.poll(async () => (await lastCall(page, 'create_block'))?.content).toBe('')
  })

  // ── #912 Tab / Shift+Tab indent / dedent ────────────────────────────────

  test('Tab indents the block under the previous sibling', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const [gs1, gs2, gs3] = ids
    expect(gs3).toBeTruthy()

    await focusBlock(page, 2) // GS_3
    await clearInvokeCalls(page)
    await page.keyboard.press('Tab')

    await expect.poll(async () => (await lastCall(page, 'move_block'))?.blockId).toBe(gs3)
    const move = await lastCall(page, 'move_block')
    expect(move?.newParentId).toBe(gs2) // becomes a child of GS_2
    expect(move?.newIndex).toBe(0)
    void gs1
  })

  test('Shift+Tab dedents the block back to the root level', async ({ page }) => {
    await openPage(page, PAGE)
    const ids = await blockIds(page)
    const gs2 = ids[1] as string
    const gs3 = ids[2] as string

    // Indent GS_3 under GS_2 first (the editor stays mounted on GS_3 across the
    // move, so no re-focus is needed before the dedent — see block-keyboard-move).
    await focusBlock(page, 2)
    await page.keyboard.press('Tab')
    await expect
      .poll(async () => {
        const m = await lastCall(page, 'move_block')
        return m?.blockId === gs3 && m?.newParentId === gs2
      })
      .toBe(true)

    // …then Shift+Tab dedents GS_3 back out from under GS_2.
    await clearInvokeCalls(page)
    await page.keyboard.press('Shift+Tab')
    await expect.poll(async () => (await lastCall(page, 'move_block'))?.blockId).toBe(gs3)
    const move = await lastCall(page, 'move_block')
    expect(move?.newParentId).not.toBe(gs2) // no longer nested under GS_2
  })

  // ── #910 Shift+Arrow at a boundary does not navigate ────────────────────

  test('Shift+ArrowUp at the start of a block does not switch blocks', async ({ page }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 1) // GS_2
    await editor.press('Home') // caret at start, collapsed

    const ids = await blockIds(page)
    await editor.press('Shift+ArrowUp')

    // Focus must remain on GS_2 — the editor (which carries data-block-id) must
    // still be mounted on the same block, NOT navigated up to GS_1.
    const liveEditor = page.locator('[data-testid="block-editor"]')
    await expect(liveEditor).toHaveAttribute('data-block-id', ids[1] as string)
  })
})
