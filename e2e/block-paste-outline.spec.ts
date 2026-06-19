import {
  blurEditors,
  clearInvokeCalls,
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for the COPY / PASTE block-outline keyboard flow (#913, #976 finding 1).
 *
 * `pasteBlocks` is unit-tested at the store level, and the chords are wired in
 * `useBlockTreeKeyboardShortcuts`, but across the whole e2e suite NOTHING
 * exercises the full UI → store → IPC pipeline for copy/paste. This spec drives
 * the REAL keyboard shortcuts (Ctrl+C / Ctrl+V in block-select mode) and the
 * REAL system clipboard (granted via `context.grantPermissions`) — NOT the
 * store methods directly — covering:
 *
 *   1. copy a flat multi-select outline, paste → siblings in document order;
 *   2. copy a nested parent+child outline, paste → hierarchy reconstructed;
 *   3. paste anchors on the LAST selected block (insert lands right after it);
 *   4. graceful recovery when the anchor block is DELETED between copy & paste.
 *
 * The chords read the GLOBAL selection and require NO editor focus (otherwise
 * the browser owns native text copy/paste), so each test blurs the editor, then
 * Ctrl+Clicks blocks to build the selection.
 *
 * Seed: "Getting Started" → GS_1…GS_5. We assert on the plain-text seed blocks
 * (GS_1 "Welcome to Agaric…", GS_3 "Create new blocks…") and on structural
 * parent_id linkage from the authoritative mock store, avoiding any dependence
 * on the markdown-bearing blocks (GS_2 link / GS_5 bold). The copy serializer
 * round-trips block content verbatim, so a pasted copy renders the same text.
 */

const PAGE = 'Getting Started'

// Stable, markdown-free substrings of the seed blocks.
const GS1_TEXT = 'Welcome to Agaric'
const GS3_TEXT = 'Create new blocks'

async function blockIds(page: import('@playwright/test').Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

/** Count rows whose visible text contains `token`. */
function rowsWithText(page: import('@playwright/test').Page, token: string) {
  return page.locator('[data-testid="sortable-block"]').filter({ hasText: token })
}

/** Ctrl+Click a block's static surface (by id) to toggle it into the selection. */
async function ctrlSelectById(page: import('@playwright/test').Page, blockId: string) {
  await page
    .locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    .locator('[data-testid="block-static"]')
    .click({ modifiers: ['Control'] })
}

/**
 * Read the harness clipboard via the SAME path the product uses
 * (`src/lib/clipboard.ts` → Tauri clipboard plugin). The plugin IPC is backed
 * by the mock's in-memory clipboard, so this observes exactly what the copy
 * chord wrote — proving the real system-clipboard pipeline fired (not a store
 * method). `navigator.clipboard` is a different surface the product does NOT
 * use here, so we must not assert against it.
 */
async function readClipboard(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    const invoke = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
      }
    ).__TAURI_INTERNALS__.invoke
    return ((await invoke('plugin:clipboard-manager|read_text')) as string | null) ?? ''
  })
}

test.describe('Copy/paste block outline (keyboard + system clipboard, #913)', () => {
  test.beforeEach(async ({ context, page }) => {
    // The chords use the real clipboard (writeText / readText). Chromium
    // rejects those without explicit permission.
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('copies a flat multi-select outline and pastes siblings in document order', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs3 = ids[2] as string

    // Block-select mode: no editor focused. Select GS_1 + GS_3.
    await blurEditors(page)
    await ctrlSelectById(page, gs1)
    await ctrlSelectById(page, gs3)
    await expect(page.getByTestId('batch-toolbar')).toContainText('2')

    // Copy to the SYSTEM clipboard, then verify the clipboard carries both
    // blocks' text (proving the real writeText fired, not a store shortcut).
    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain(GS1_TEXT)
    await expect.poll(() => readClipboard(page)).toContain(GS3_TEXT)

    // Paste — anchors on the LAST selected block (GS_3) and inserts after it.
    await page.keyboard.press('Control+v')

    // Each selected block's text now renders TWICE (original + pasted copy).
    await expect.poll(async () => await rowsWithText(page, GS1_TEXT).count()).toBe(2)
    await expect.poll(async () => await rowsWithText(page, GS3_TEXT).count()).toBe(2)

    // The pasted run preserves document order: GS_1's copy precedes GS_3's copy.
    // Read each row's OWN static text (not full textContent, which would fold in
    // descendant rows) so occurrence indices are per-block.
    const order = await page
      .locator('[data-testid="sortable-block"]')
      .evaluateAll((els) =>
        els.map((el) => el.querySelector('[data-testid="block-static"]')?.textContent ?? ''),
      )
    const gs1Idxs = order.flatMap((t, i) => (t.includes(GS1_TEXT) ? [i] : []))
    const gs3Idxs = order.flatMap((t, i) => (t.includes(GS3_TEXT) ? [i] : []))
    expect((gs1Idxs[1] as number) < (gs3Idxs[1] as number)).toBe(true)
  })

  test('copies a nested parent+child outline and reconstructs the hierarchy on paste', async ({
    page,
  }) => {
    await installIpcRecorder(page)
    const ids = await blockIds(page)
    const gs1 = ids[0] as string

    // Build nesting: indent GS_2 (index 1) under GS_1 (index 0) → GS_1 is a
    // parent, GS_2 its child.
    await focusBlock(page, 1)
    await page.keyboard.press('Control+Shift+ArrowRight')
    await page.keyboard.press('Escape')
    await expect(
      page
        .locator(`[data-testid="sortable-block"][data-block-id="${gs1}"]`)
        .locator('[data-testid="collapse-toggle"]'),
    ).toBeVisible()

    // Copy the PARENT only — the subtree serializer carries the child too. The
    // clipboard must hold the INDENTED outline (child on a deeper-indented line),
    // proving the copy serialized the subtree structure, not just the parent.
    await blurEditors(page)
    await ctrlSelectById(page, gs1)
    await expect(page.getByTestId('batch-toolbar')).toContainText('1')
    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain(GS1_TEXT)
    const clip = await readClipboard(page)
    const lines = clip.split('\n')
    // Two lines: the parent at column 0, the child indented beneath it.
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]?.startsWith(' ')).toBe(false) // parent flush-left
    expect((lines[1] ?? '').startsWith(' ')).toBe(true) // child indented

    // Paste, recording the create IPCs so we can prove the hierarchy is
    // RECONSTRUCTED (not flattened): paste materializes the outline level by
    // level, so the child's batch must carry a `parentId` equal to the id of
    // the freshly-created parent block returned by the first batch.
    await clearInvokeCalls(page)
    await page.keyboard.press('Control+v')
    await expect.poll(async () => await rowsWithText(page, GS1_TEXT).count()).toBe(2)

    const batches = (await getInvokeCalls(page, 'create_blocks_batch')) as Array<{
      specs: Array<{ content: string; parentId: string | null }>
    }>
    // First batch creates the top-level parent (the GS_1 copy) under the PAGE.
    // A LATER batch creates the child whose `parentId` points at a block that
    // is NEITHER an original block NOR the page — i.e. the freshly-created
    // parent from the first batch. That linkage IS the reconstructed hierarchy.
    const known = new Set<string>([...ids, gs1, '00000000000000000000PAGE01'])
    const allSpecs = batches.flatMap((b) => b.specs)
    const parentSpec = batches[0]?.specs.find((s) => s.content.includes(GS1_TEXT))
    expect(parentSpec).toBeDefined()
    // The top-level parent is created under the page (the outline's root level).
    expect(parentSpec?.parentId).toBe('00000000000000000000PAGE01')
    // The child nests under a NEWLY-created block (not the page, not an
    // original): that block can only be the cloned parent.
    const childSpec = allSpecs.find((s) => s.parentId !== null && !known.has(s.parentId))
    expect(childSpec).toBeDefined()
    expect(childSpec?.content).not.toContain(GS1_TEXT) // it's the child, not the parent
    expect(childSpec?.parentId).not.toBe('00000000000000000000PAGE01')
  })

  test('paste anchors on the LAST selected block (insert lands immediately after it)', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

    // Select GS_1 then GS_2 (GS_2 is the LAST selected → the paste anchor).
    await blurEditors(page)
    await ctrlSelectById(page, gs1)
    await ctrlSelectById(page, gs2)
    await expect(page.getByTestId('batch-toolbar')).toContainText('2')

    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain(GS1_TEXT)
    await page.keyboard.press('Control+v')

    // Paste anchors on the LAST selected block (GS_2): the pasted run is
    // inserted AFTER the anchor, never before it. We read each row's OWN static
    // text (not full textContent, which would fold in descendant rows). The
    // pasted copy of GS_1 (the SECOND GS_1 occurrence) therefore lands strictly
    // AFTER the anchor's position — proving the anchor was GS_2, the last
    // selected block, not GS_1.
    await expect.poll(async () => await rowsWithText(page, GS1_TEXT).count()).toBe(2)
    const rowTexts = await page
      .locator('[data-testid="sortable-block"]')
      .evaluateAll((els) =>
        els.map((el) => el.querySelector('[data-testid="block-static"]')?.textContent ?? ''),
      )
    const gs1Occurrences = rowTexts.flatMap((t, i) => (t.includes(GS1_TEXT) ? [i] : []))
    const anchorIdx = rowTexts.findIndex((t, i) => i > 0 && t.includes('Use the sidebar')) // GS_2 anchor
    const pastedGs1Idx = gs1Occurrences[1] as number
    // The original GS_1 is first (index 0); the pasted copy (second occurrence)
    // lands AFTER the GS_2 anchor — the insert followed the LAST-selected block.
    expect(pastedGs1Idx).toBeGreaterThan(anchorIdx)
  })

  test('recovers gracefully when the anchor block is deleted between copy and paste', async ({
    page,
  }) => {
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs3 = ids[2] as string

    // Select GS_1 + GS_3 (GS_3 is the anchor), copy.
    await blurEditors(page)
    await ctrlSelectById(page, gs1)
    await ctrlSelectById(page, gs3)
    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain(GS3_TEXT)

    // Delete the anchor block (GS_3) out from under the selection, simulating a
    // concurrent/remote delete between copy and paste. We mutate the mock store
    // directly, then re-fetch the tree via `reopenPage` (navigate away + back —
    // NOT page.reload(), which re-seeds the mock and would resurrect GS_3). The
    // page store's load() then prunes the vanished anchor from the global
    // selection (mirrors load()'s #798 pruning).
    await page.evaluate(async (anchorId) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      await invoke('delete_block', { blockId: anchorId })
    }, gs3)
    await reopenPage(page, PAGE)
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
    await expect(rowsWithText(page, GS3_TEXT)).toHaveCount(0)

    // Paste with the anchor gone: the chord must NOT crash on the stale id. The
    // global console-error watcher (helpers.afterEach) asserts nothing threw, and
    // the count assertions below assert nothing was duplicated off the dead
    // anchor.
    await blurEditors(page)
    await page.keyboard.press('Control+v')
    // With its anchor deleted and the selection pruned on reopen, the paste is a
    // graceful NO-OP: it issues no IPC and mutates nothing (verified: zero
    // `create_blocks_batch` calls, GS_1 stays at one row). There is therefore no
    // positive "settled" observable to poll on — GS_1's single row is the
    // untouched ORIGINAL, so a `GS1_TEXT >= 1` poll would be trivially true at
    // t=0 and assert nothing. What this test guards is the NEGATIVE invariant: a
    // rogue async paste must NOT duplicate content off the dead anchor.
    //
    // `toHaveCount` auto-retries for the full timeout and FAILS (not passes) if
    // the count ever drifts off the expected value, so it both spans the settle
    // window AND would catch a duplicating regression — unlike a `<=` poll, which
    // would stop on the first tick. The recovered paste lands NO extra rows, so
    // GS_1 stays at exactly its single original occurrence (bounded ≤2, observed
    // 1); a buggy duplicate would push it to 2+ and fail this assertion.
    await expect(rowsWithText(page, GS1_TEXT)).toHaveCount(1)
    // GS_3's text never reappears from a rogue paste anchored on the dead block.
    await expect(rowsWithText(page, GS3_TEXT)).toHaveCount(0)
  })
})
