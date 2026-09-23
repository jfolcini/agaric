import {
  blurEditors,
  expect,
  focusBlock,
  openPage,
  readClipboard,
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
 * clipboard plugin IPC (the mock's in-memory clipboard, read back through
 * `readClipboard`) — NOT the store methods directly — covering:
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
 * on the markdown-bearing blocks (GS_2 link / GS_5 bold). A copy pastes back
 * with its content verbatim, so a pasted copy renders the same text.
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

const PAGE_ID = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000BLOCK01'
const GS3 = '0000000000000000000BLOCK03'
const GS5 = '0000000000000000000BLOCK05'
const FENCED = '```\nfirst line\nsecond line\n```'
const CHILD_TEXT = 'a child that travels with its parent'

interface Row {
  id: string
  content: string | null
}

function ipc<T>(page: import('@playwright/test').Page, cmd: string, args: unknown): Promise<T> {
  return page.evaluate(
    ({ c, a }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke(c, a)
    },
    { c: cmd, a: args },
  ) as Promise<T>
}

async function childrenOf(page: import('@playwright/test').Page, parentId: string) {
  const resp = await ipc<{ items: Row[] }>(page, 'list_blocks', {
    request: { parentId, limit: 100 },
  })
  return resp.items
}

/** Dispatch a native paste of `text/plain` onto the live editor. */
async function pasteText(editor: import('@playwright/test').Locator, text: string) {
  await editor.evaluate((el, value) => {
    const data = new DataTransfer()
    data.setData('text/plain', value)
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
  }, text)
}

/** Ctrl+Click a block's static surface (by id) to toggle it into the selection. */
async function ctrlSelectById(page: import('@playwright/test').Page, blockId: string) {
  // Click a stable non-interactive corner (the block's padding), not the
  // element center — seed blocks render inline links/tag chips whose horizontal
  // position shifts with font metrics, so a center click can land on an inner
  // `<a>`/chip (which swallows the selection toggle) on some platforms.
  await page
    .locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    .locator('[data-testid="block-static"]')
    .click({ modifiers: ['Control'], position: { x: 6, y: 6 } })
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
    const ids = await blockIds(page)
    const gs1 = ids[0] as string
    const gs2 = ids[1] as string

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

    // Copy the PARENT only — the copy carries the child too. The clipboard
    // must hold the INDENTED outline (child on a deeper-indented line),
    // proving the copy rendered the subtree structure, not just the parent.
    await blurEditors(page)
    await ctrlSelectById(page, gs1)
    await expect(page.getByTestId('batch-toolbar')).toContainText('1')
    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain(GS1_TEXT)
    const lines = (await readClipboard(page)).trimEnd().split('\n')
    // Two lines: the parent at column 0, the child indented beneath it.
    expect(lines).toHaveLength(2)
    expect(lines[0]?.startsWith(' ')).toBe(false) // parent flush-left
    expect((lines[1] ?? '').startsWith(' ')).toBe(true) // child indented

    // Paste, then read the backend back: the pasted parent's copy carries a
    // copy of the child, so the hierarchy was RECONSTRUCTED, not flattened.
    await page.keyboard.press('Control+v')
    await expect.poll(async () => await rowsWithText(page, GS1_TEXT).count()).toBe(2)
    const topLevel = await childrenOf(page, PAGE_ID)
    const copy = topLevel.find((r) => r.id !== gs1 && r.content?.includes(GS1_TEXT))
    const gs2Content = (await childrenOf(page, gs1)).find((r) => r.id === gs2)?.content
    const copyChildren = await childrenOf(page, copy?.id ?? '')
    expect(copyChildren.map((r) => r.content)).toEqual([gs2Content])
    expect(copyChildren[0]?.id).not.toBe(gs2)
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
    // `paste_blocks` calls, GS_1 stays at one row). There is therefore no
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

// #5140 Phase 3b — copy renders the outline in the backend's source grammar
// (`get_blocks_source`) and paste parses it back there (`paste_blocks`), so a
// multi-line block stays one block and a copied subtree stays nested wherever
// it is pasted. Every assertion reads the mock backend back.

test.describe('Copy/paste through the source grammar (#5140 Phase 3b)', () => {
  test.beforeEach(async ({ context, page }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await waitForBoot(page)
  })

  test('Ctrl+C then Ctrl+V of a two-line fenced code block pastes ONE block with identical content', async ({
    page,
  }) => {
    await ipc(page, 'edit_block', { blockId: GS1, toText: FENCED })
    await openPage(page, PAGE)
    const before = await childrenOf(page, PAGE_ID)

    await blurEditors(page)
    await ctrlSelectById(page, GS1)
    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain('second line')
    await page.keyboard.press('Control+v')

    await expect
      .poll(async () => (await childrenOf(page, PAGE_ID)).length)
      .toBeGreaterThan(before.length)
    const after = await childrenOf(page, PAGE_ID)
    expect(after).toHaveLength(before.length + 1)
    const copy = after[after.findIndex((r) => r.id === GS1) + 1]
    expect(copy?.id).not.toBe(GS1)
    expect(copy?.content).toBe(FENCED)
    expect(await childrenOf(page, copy?.id ?? '')).toEqual([])
  })

  test('a copied parent and child pasted into an empty editor stays nested', async ({ page }) => {
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: CHILD_TEXT,
      parentId: GS3,
      index: null,
      scope: { kind: 'global' },
      blockId: null,
    })
    await openPage(page, PAGE)
    const gs3Content = (await childrenOf(page, PAGE_ID)).find((r) => r.id === GS3)?.content

    await blurEditors(page)
    await ctrlSelectById(page, GS3)
    await page.keyboard.press('Control+c')
    await expect.poll(() => readClipboard(page)).toContain(CHILD_TEXT)
    const clip = await readClipboard(page)

    // A fresh empty block after GS_1, focused, receives the OS paste.
    const first = await focusBlock(page, 0)
    await first.press('End')
    await first.press('Enter')
    const live = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(live.locator('p.is-editor-empty')).toBeVisible()
    await pasteText(live, clip)
    // Leave by clicking another block: a blur commits whatever the paste left
    // in the editor (Escape would discard it).
    await page.locator(`[data-testid="block-static"][data-block-id="${GS5}"]`).click()

    const copies = async () =>
      (await childrenOf(page, PAGE_ID)).filter((r) => r.content === gs3Content && r.id !== GS3)
    await expect.poll(async () => (await copies()).length).toBe(1)
    const copy = (await copies())[0]
    expect((await childrenOf(page, copy?.id ?? '')).map((r) => r.content)).toEqual([CHILD_TEXT])
  })
})
