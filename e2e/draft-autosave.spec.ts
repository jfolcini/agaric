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
 * FINDING (documented, not asserted as a test — a real behaviour
 * discovered while probing this spec, not a defect in the spec itself):
 * pressing Enter to commit-and-split fires NEITHER `delete_draft` NOR
 * `flush_draft` for the departed block, even when that block already had
 * a persisted draft row (typed, waited past the 2000ms debounce so
 * `save_draft` fired, THEN pressed Enter — probed directly, no IPC
 * showed up for either command in the following 3s beyond the `Enter`'s
 * own `edit_block`). This means Enter-driven commits do not clean up a
 * pre-existing draft row for the block they just committed — it is left
 * for the NEXT `flushAllDrafts()` boot sweep to reconcile (harmlessly,
 * since by then the draft's content and the committed content are
 * identical). This contradicts `useDraftAutosave`'s own doc comment,
 * which describes Effect B as unconditionally flushing on "block
 * switch" — that branch is structurally unreachable through the current
 * per-block wiring (see above), and Enter does not go through
 * `useEditorBlur`'s blur-discard path either. Worth a follow-up issue;
 * out of scope to fix here (attribute-only test hooks only).
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
})
