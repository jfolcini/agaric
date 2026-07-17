/**
 * E2E coverage for draft autosave / crash recovery (#2685).
 *
 * Before this spec `useDraftAutosave` (src/hooks/useDraftAutosave.ts) —
 * "saves in-progress editor content on blur and restores it at boot if
 * the app crashed mid-edit" (docs/FEATURE-MAP.md) — had zero e2e
 * coverage; a repo-wide grep of `e2e/*.spec.ts` for
 * `draft|save_draft|list_drafts` matched only an unrelated comment in
 * image-node.spec.ts.
 *
 * All assertions below are made on the OUTGOING IPC calls the hook
 * fires (`installIpcRecorder` / `getInvokeCalls`), not on the mock's
 * return values — the hook's save/flush/discard code paths are fully
 * exercisable that way with NO mock changes. Every scenario below was
 * verified empirically (recorded IPC dumps) before the assertion was
 * written, not assumed from the hook's own doc comments — see the two
 * findings below where the comments and the actual wiring disagree:
 *
 *   - Typing debounces then fires `save_draft(blockId, content)`.
 *   - Blurring a block (click away, or Enter-commit-and-move-to-a-new-
 *     sibling) discards the draft via `delete_draft` — NOT a flush
 *     (useEditorBlur.ts: "Blur is deliberately NOT a flush path").
 *     `EditableBlock` is one instance PER block
 *     (`isFocused ? blockId : null`, src/components/editor/EditableBlock.tsx:329),
 *     so Enter-committing and moving to a new sibling still routes the
 *     DEPARTED block's hook instance through the ordinary
 *     `blockId → null` blur transition.
 *   - `flush_draft` (Effect B's "unmount while STILL focused, no blur
 *     ever fired" branch) requires removing the focused block from the
 *     DOM without a native blur event reaching it first. The block
 *     context menu is tagged `data-editor-portal`
 *     (useEditorBlur.ts's portal guard), so deleting the
 *     CURRENTLY-FOCUSED block through it does not blur first — the
 *     block unmounts still "focused", and Effect B's cleanup fires
 *     `save_draft` (final live content) then `flush_draft`, never
 *     `delete_draft`, for that block.
 *   - Clearing a block back to empty discards immediately (no debounce
 *     wait) — the #770 gap-3 "genuine clear" branch in
 *     useDraftAutosave.ts.
 *
 * SUPERSEDED FINDING (#2786, was previously documented here as an open
 * gap): pressing Enter to CARET-SPLIT a block (mid-content caret, text
 * both before and after it) now DOES discard the departed (split-source)
 * block's pre-existing draft — via `delete_draft`, never `flush_draft` —
 * immediately after the caret-split branch's `edit()` commits the
 * before-caret text (`useBlockKeyboardHandlers.ts` `handleEnterSave`'s
 * explicit `discardDraft(focusedBlockId)` call, added by #2786 alongside
 * the #2803 spaces-move fix). Before #2786, the same repro (type, wait
 * past the 2000ms debounce so `save_draft` fired, THEN press Enter
 * mid-content) showed neither `delete_draft` nor `flush_draft` firing for
 * that block, leaving a stale pre-split draft row for the NEXT
 * `flushAllDrafts()` boot sweep to (harmlessly, by luck) reconcile. See
 * "Enter caret-splits a block" below — reverting #2786 fails that test.
 * The Enter-AT-THE-END path (no caret split, `handleFlush()` + empty
 * `createBelow`) is unaffected by #2786 and still does not exercise
 * `discardDraft` — out of scope here, not asserted either way.
 *
 * BLOCKED, documented, not faked — the headline "reload mid-edit
 * restores the unsaved text at boot" crash-recovery round trip:
 *
 * This cannot be simulated against the current mock for TWO independent,
 * compounding reasons:
 *
 *   1. `save_draft` / `flush_draft` / `delete_draft` / `list_drafts` /
 *      `flush_all_drafts` (src/lib/tauri-mock/handlers.ts:4510-4519) are
 *      pure stateless stubs — `flush_all_drafts` hardcodes
 *      `{ flushed: 0 }` unconditionally, `list_drafts` always returns
 *      `[]`. Even a debounced `save_draft` that lands right before a
 *      `page.reload()` is never recorded anywhere the boot-time flush
 *      could read back.
 *   2. Even if (1) were fixed with an in-memory `drafts` map, it would
 *      not survive the reload needed to re-trigger
 *      `useAppBootRecovery`'s mount effect: `setupMock()`
 *      (src/lib/tauri-mock/index.ts:66) unconditionally calls
 *      `seedBlocks()` on every fresh page load, wiping ALL module-scoped
 *      mock state — including any drafts map — before `App.tsx` ever
 *      mounts and calls `flushAllDrafts()`. There is no
 *      localStorage/IndexedDB-backed persistence layer under the mock
 *      that could survive a full navigation, so a genuine crash → reload
 *      → recover round trip has no substrate to run on in Playwright.
 *
 * Fixing this would mean adding cross-reload persistence to the mock
 * itself (e.g. a localStorage-backed drafts table) — a materially larger
 * change than the "attribute-only test hooks" this task's conventions
 * allow, and arguably its own follow-up issue. The observable, real
 * production code path (every IPC call the hook fires, in the right
 * order, with the right payload) IS covered below; only the "does the
 * backend's DB-side flush actually restore content across a process
 * boundary" half is out of reach here. That half already has direct
 * coverage elsewhere: `src/hooks/__tests__/useDraftAutosave.test.ts`
 * (~23 cases, including boot-resurrection) and `src-tauri`'s `drafts.rs`
 * Rust tests exercise the real backend directly.
 */

import {
  blurEditors,
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

const PAGE = 'Getting Started'

/** Most recently recorded payload for a command, or null. */
async function lastCall(
  page: import('@playwright/test').Page,
  cmd: string,
): Promise<Record<string, unknown> | null> {
  const calls = await getInvokeCalls(page, cmd)
  return calls.at(-1) ?? null
}

async function liveEditorBlockId(page: import('@playwright/test').Page): Promise<string | null> {
  return page.locator('[data-testid="block-editor"]').first().getAttribute('data-block-id')
}

test.describe('Draft autosave', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await installIpcRecorder(page)
  })

  test('typing into a block debounces then fires save_draft with the live content', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 0)
    const blockId = await liveEditorBlockId(page)

    await editor.press('Control+a')
    await editor.pressSequentially('unsaved draft text')

    // No `waitForTimeout` — `expect.poll` absorbs the 2000ms trailing
    // debounce (DRAFT_DEBOUNCE_MS, src/hooks/useDraftAutosave.ts).
    await expect
      .poll(async () => (await lastCall(page, 'save_draft'))?.['content'], { timeout: 8000 })
      .toBe('unsaved draft text')

    const call = await lastCall(page, 'save_draft')
    expect(call?.['blockId']).toBe(blockId)
  })

  test('blurring a block by clicking away (no commit) discards its draft via delete_draft, not a flush', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 0)
    const blockId = await liveEditorBlockId(page)

    await editor.press('Control+a')
    await editor.pressSequentially('unsaved edit')
    await blurEditors(page)

    await expect
      .poll(async () => (await getInvokeCalls(page, 'delete_draft')).map((c) => c['blockId']))
      .toContain(blockId)

    const flushedIds = (await getInvokeCalls(page, 'flush_draft')).map((c) => c['blockId'])
    expect(flushedIds).not.toContain(blockId)
  })

  test('deleting the still-focused block via its context menu flushes its draft via flush_draft, not a discard', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 0)
    const blockId = await liveEditorBlockId(page)

    await editor.press('Control+a')
    await editor.pressSequentially('unsaved content, never blurred')

    // The context menu is tagged `data-editor-portal` (useEditorBlur.ts) —
    // opening/using it does NOT blur the still-focused editor first. The
    // block is removed from the DOM while its `useDraftAutosave` instance
    // still believes it is focused, hitting Effect B's real "unmount
    // while focused" branch.
    const block = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    await block.click({ button: 'right' })
    const menu = page.getByRole('menu', { name: 'Block actions' }).last()
    await menu.getByRole('menuitem', { name: 'Delete' }).click()

    await expect
      .poll(async () => (await getInvokeCalls(page, 'flush_draft')).map((c) => c['blockId']))
      .toContain(blockId)

    const discardedIds = (await getInvokeCalls(page, 'delete_draft')).map((c) => c['blockId'])
    expect(discardedIds).not.toContain(blockId)
  })

  test('clearing a block back to empty discards the pending draft immediately, without waiting for the debounce', async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 0)
    const blockId = await liveEditorBlockId(page)

    await editor.press('Control+a')
    await editor.pressSequentially('temp')
    await editor.press('Control+a')
    await editor.press('Backspace')

    // The #770 gap-3 "genuine clear" branch in useDraftAutosave.ts fires
    // discardDraftFor synchronously on the empty-content transition —
    // no 2000ms debounce wait needed here (unlike the first test above).
    await expect
      .poll(async () => (await getInvokeCalls(page, 'delete_draft')).map((c) => c['blockId']))
      .toContain(blockId)

    // The debounced save never got a chance to fire empty content.
    const saveCalls = await getInvokeCalls(page, 'save_draft')
    expect(saveCalls.some((c) => c['blockId'] === blockId && c['content'] === '')).toBe(false)
  })

  // #2813 (#2786 fix) — Enter caret-splitting a block must not strand the
  // departed block's pre-existing draft row. `list_drafts` / `save_draft` /
  // `flush_draft` / `delete_draft` are all pure no-op stubs in the mock
  // (src/lib/tauri-mock/handlers.ts, grepped: `returnNull` / `returnEmptyArray`
  // / `{ flushed: 0 }` — no in-memory drafts map at all), so there is no
  // observable draft ROW to assert absent, and a `page.reload()` cannot
  // distinguish fixed-vs-buggy behaviour either: nothing the mock ever
  // "persists" survives a reload regardless of which code path ran (see
  // this file's own header — `setupMock()` wipes all module-scoped mock
  // state on every fresh load). The only substrate that actually
  // discriminates the fix is the OUTGOING IPC call the discard makes,
  // which is exactly what every other test in this file already asserts
  // on — so this test follows suit instead of reaching for a reload.
  test("Enter caret-splits a block: the departed block's pre-existing draft is discarded via delete_draft, not flushed (#2786)", async ({
    page,
  }) => {
    await openPage(page, PAGE)
    const editor = await focusBlock(page, 0)
    const blockId = await liveEditorBlockId(page)

    // Build "helloworld" with the caret deterministically between the two
    // halves, same recipe as block-keyboard-fundamentals.spec.ts's caret-split
    // test (typing the whole word in one go and confirming it committed
    // avoids a mid-stream caret-move race under CI's tighter timing).
    await editor.press('Control+a')
    await editor.pressSequentially('helloworld')
    await expect(editor).toHaveText('helloworld')

    // Let the debounced save_draft actually land BEFORE the split, so a
    // real (already-persisted) draft row exists for the split to discard —
    // this is the exact repro this file's header comment cites for #2786.
    await expect
      .poll(async () => (await lastCall(page, 'save_draft'))?.['content'], { timeout: 8000 })
      .toBe('helloworld')
    expect((await lastCall(page, 'save_draft'))?.['blockId']).toBe(blockId)

    // Drive the caret to sit between "hello" and "world" (offset 5),
    // polling the DOM selection so the split position never depends on a
    // single keystroke winning a race.
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

    // The split committed "hello" into the SAME block id (the new block
    // created below holds "world") — confirm the split actually happened
    // before trusting the draft-discard assertion below.
    await expect.poll(async () => (await lastCall(page, 'edit_block'))?.toText).toBe('hello')

    // #2786 — the caret-split branch now discards the departed block's
    // stale ("helloworld") draft via delete_draft immediately after the
    // edit() commit, mirroring persistUnmount's contract on every other
    // programmatic block switch.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'delete_draft')).map((c) => c['blockId']))
      .toContain(blockId)

    // Deliberately NOT a flush — flushing the stale FULL pre-split text
    // would append a second edit_block that clobbers the split just made.
    const flushedIds = (await getInvokeCalls(page, 'flush_draft')).map((c) => c['blockId'])
    expect(flushedIds).not.toContain(blockId)
  })
})
