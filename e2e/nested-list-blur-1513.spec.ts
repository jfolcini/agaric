import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E regression for #1513 — nested lists silently dropped on blur.
 *
 * The editor's `ListItem` (from `@tiptap/extension-list-item`) keeps the
 * default content `paragraph block*` and binds `Tab` → `sinkListItem`, so a
 * list item can legally contain a NESTED list. Before the fix, the flat
 * markdown serializer treated the nested list as an unknown inline node,
 * emitted nothing, and fired `onUnknownNode('listItem')` — so when the editor
 * blurred and reserialized, the nested item's text was lost (DATA LOSS).
 *
 * Reaching the nested structure through the REAL UI:
 *
 *   Agaric is an outliner: each top-level list item is its own page-level
 *   *block*, and `Enter` in a block creates a new sibling block rather than a
 *   new `<li>` in the same ProseMirror doc (see use-block-keyboard.ts —
 *   `onEnterSave`). The within-block `listItem → bulletList` nesting that the
 *   serializer fix targets therefore only arises when a SINGLE block already
 *   holds a multi-item list (e.g. content authored/imported as multi-line list
 *   markdown). We reproduce that exactly: seed one block with two-item list
 *   markdown via the `edit_block` IPC, re-navigate so the editor re-parses it
 *   into a 2-item `bulletList` in one ProseMirror doc, then press `Tab` on the
 *   item so ProseMirror's `sinkListItem` nests it under the first — producing
 *   the `listItem → bulletList` structure that used to be dropped on blur.
 *
 * `Tab` is normally intercepted by the block outliner (block-level indent). We
 * opt out via `localStorage` (`agaric-tab-indents-blocks=false`) BEFORE boot so
 * `Tab` falls through to ProseMirror's `sinkListItem` — exactly the path the
 * issue names (use-block-keyboard.ts:448-452, `isTabIndentEnabled`).
 */

// Seed id from src/lib/tauri-mock/seed.ts (BLOCK_GS_1, first content block of
// the "Getting Started" page).
const BLOCK_GS_1 = '0000000000000000000BLOCK01'

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

/** Overwrite a block's markdown content directly via the mock `edit_block` IPC. */
async function seedBlockContent(
  page: import('@playwright/test').Page,
  blockId: string,
  toText: string,
): Promise<void> {
  await page.evaluate(
    ({ id, text }) => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
        .__TAURI_INTERNALS__.invoke
      return invoke('edit_block', { blockId: id, toText: text })
    },
    { id: blockId, text: toText },
  )
}

/**
 * After seeding new content into a block, force the page editor to re-fetch and
 * re-parse it: navigate away to another seeded page (Quick Notes) via the Pages
 * browser, then back to Getting Started via the quick-access (recent) bar — a
 * single, unambiguous locator (the Pages browser's "Getting Started" row is a
 * second match, so `openPage`'s `getByText` is strict-mode-ambiguous once the
 * page is in the recents bar). The mock store persists across in-app nav (only
 * `reload()` / `__resetTauriMock__` reseed), so the edited content survives.
 */
async function reopenGettingStartedAfterSeed(page: import('@playwright/test').Page): Promise<void> {
  await openPage(page, 'Quick Notes')
  await page
    .getByTestId('quick-access-bar')
    .getByRole('button', { name: 'Getting Started' })
    .click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

/**
 * Commit the edited block the way #1513 describes — a genuine BLUR (focus
 * leaves the editor) so `useEditorBlur` serializes + flushes the doc and the
 * block re-renders at rest.
 *
 * NB: do NOT use the `blurEditors` helper here. It presses `Escape` first,
 * which the block keyboard map binds to "cancel editing, DISCARD changes"
 * (use-block-keyboard.ts:320 → `onEscapeCancel`) — that reverts the in-editor
 * Tab-nesting before any serialize runs, so the at-rest content would (always)
 * be the pre-edit value and the round-trip would never be exercised. We instead
 * move focus to another block's static surface, which drains the blur+flush
 * (serialize) path that the regression is actually about.
 */
async function commitBlockByBlur(page: import('@playwright/test').Page): Promise<void> {
  // Click the SECOND block's at-rest surface: focus leaves the first block's
  // editor → onBlur → serialize + flush.
  await page.locator('[data-testid="block-static"]').nth(1).click()
  // Wait until the first block is no longer in edit mode (its editor unmounts
  // and the static surface returns).
  await expect(
    page.locator('[data-testid="sortable-block"]').first().locator('[data-testid="block-static"]'),
  ).toBeVisible()
}

test.describe('Nested list survives blur (#1513)', () => {
  test.beforeEach(async ({ page }) => {
    // Restore Tab as the in-editor key so it reaches `sinkListItem` instead of
    // the block-level indent handler (see use-block-keyboard.ts:448-452).
    await page.addInitScript(() => {
      window.localStorage.setItem('agaric-tab-indents-blocks', 'false')
    })
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('a Tab-nested list item is not dropped after blur', async ({ page }) => {
    // Seed the first block with a two-item bullet list, then re-navigate to the
    // page (NOT reload — reload reseeds the mock and wipes the edit) so the
    // block list re-reads the edited store and the editor parses it into a
    // single 2-item `bulletList` ProseMirror doc.
    await seedBlockContent(page, BLOCK_GS_1, '- parent\n- child')
    await reopenGettingStartedAfterSeed(page)

    const editor = await focusBlock(page)
    // Sanity: the block holds a flat two-item list before we nest it.
    await expect(editor.locator('ul > li')).toHaveCount(2)

    // Put the cursor in the SECOND item ("child"), then Tab → `sinkListItem`
    // nests it under the first ("parent"): listItem(parent) → bulletList(child).
    await editor.locator('ul > li', { hasText: 'child' }).click()
    await page.keyboard.press('Tab')

    // The live editor now shows the nested list (a <ul> inside an <li>).
    await expect(editor.locator('ul ul li')).toContainText('child')

    // Blur → the block serializes its ProseMirror doc to markdown and re-renders
    // at rest. This is the exact path that used to drop the nested item.
    await commitBlockByBlur(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')

    // parent AND the nested child must both survive the round-trip.
    await expect(staticBlock).toContainText('parent')
    await expect(staticBlock).toContainText('child')
    // The nested item is rendered as a sublist (a <ul> inside an <li>), not
    // flattened or lost.
    await expect(staticBlock.locator('ul ul li')).toContainText('child')
  })

  test('re-focusing the block round-trips the nested list back into the editor', async ({
    page,
  }) => {
    await seedBlockContent(page, BLOCK_GS_1, '- top\n- nested')
    await reopenGettingStartedAfterSeed(page)

    const editor = await focusBlock(page)
    await expect(editor.locator('ul > li')).toHaveCount(2)
    await editor.locator('ul > li', { hasText: 'nested' }).click()
    await page.keyboard.press('Tab')
    await expect(editor.locator('ul ul li')).toContainText('nested')

    await commitBlockByBlur(page)

    // Re-mount the editor from the serialized markdown: the nested structure
    // must reappear (serialize → parse round-trip is lossless).
    const reopened = await focusBlock(page)
    await expect(reopened.locator('ul ul li')).toContainText('nested')
    await expect(reopened.locator('ul > li').first()).toContainText('top')
  })
})
