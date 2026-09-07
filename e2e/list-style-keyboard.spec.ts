import type { Locator, Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  reopenPage,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
  waitForStableBlockRows,
} from './helpers'

/**
 * #4552 slice 3 — the keyboard grain of `listStyle` blocks.
 *
 *   - Enter on a styled, non-empty block creates the next block with the SAME
 *     `listStyle`, so a numbered procedure keeps numbering (`1.` `2.` `3.`).
 *   - Enter on an EMPTY styled block leaves the list: the style is cleared and
 *     no sibling is created.
 *   - Backspace on an EMPTY styled block clears the style first; the second
 *     Backspace deletes the block.
 *
 * The fourth behaviour — Backspace at the START of a NON-empty styled block
 * clearing the style before the merge — is covered only by the unit tests in
 * `src/components/block-tree/__tests__/use-block-action-orchestration.test.ts`,
 * for the reason `block-editing-text.spec.ts` already records for plain merges:
 * the handler fires off ProseMirror's internal selection, so no caret-at-start
 * precondition is deterministic from outside the editor. Measured here: on a
 * styled block `Home` and `Control+Home` do not move the caret at all (the
 * leading marker widget is `contenteditable=false`), and an ArrowLeft walk
 * lands on the first text position only intermittently.
 *
 * Every step that depends on a block KNOWING its style runs after a
 * `reopenPage`. The batch that feeds the markers — and the focused editor's
 * own reading of its style — refetches on the backend's
 * `block:properties-changed` event, which the JS tauri mock never emits (same
 * caveat as `slash-commands-coverage`), so in this harness a property write
 * only becomes visible on the next mount. The reopen is also what proves the
 * writes persisted rather than living in component state.
 *
 * Seed: "Getting Started" has 5 blocks; the first one is the one styled here.
 */

const SEED_ROWS = 5

const rows = (page: Page) => page.locator('[data-testid="sortable-block"]')
const marker = (row: Locator) => row.getByTestId('list-marker')
const editorIn = (row: Locator) => row.locator('[data-testid="block-editor"]')

/** Type `text` into the first block and make it a numbered-list block. */
async function styleFirstBlockAsNumbered(page: Page, text: string): Promise<void> {
  await focusBlock(page)
  await page.keyboard.press('Control+a')
  await page.keyboard.type(text)
  const list = await typeSlashCommand(page, 'numbered')
  const item = list.locator('[data-testid="suggestion-item"]', { hasText: 'NUMBERED' }).first()
  await expect(item).toBeVisible()
  await item.click()
  // The handler flushes the text before writing the property (#4577), so
  // Escape keeps both.
  await saveBlock(page, 'Escape')
}

/** The `set_property` calls that wrote a `listStyle`, in call order. */
async function listStyleWrites(page: Page): Promise<Array<Record<string, unknown>>> {
  const calls = await getInvokeCalls(page, 'set_property')
  return calls.filter((c) => c['key'] === 'listStyle')
}

/**
 * Enter at the end of row `index` (a styled block whose style the frontend
 * already knows): the new row below carries the same style, and — because
 * the harness has no property-changed event — is asserted after a reopen.
 */
async function continueListFrom(page: Page, index: number, writesSoFar: number): Promise<void> {
  await focusBlock(page, index)
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await waitForStableBlockRows(page, SEED_ROWS + index + 1)
  await expect(editorIn(rows(page).nth(index + 1))).toBeVisible()
  await expect.poll(() => listStyleWrites(page)).toHaveLength(writesSoFar + 1)
}

test.describe('listStyle keyboard grain (#4552 slice 3)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await waitForStableBlockRows(page, SEED_ROWS)
    await installIpcRecorder(page)
  })

  test('Enter continues the numbering; Enter on the empty next item leaves the list', async ({
    page,
  }) => {
    await styleFirstBlockAsNumbered(page, 'step one')
    await reopenPage(page, 'Getting Started')
    await expect(marker(rows(page).nth(0))).toHaveText('1.')

    // "1." → Enter → a styled "2.", typed into and committed by the blur.
    await continueListFrom(page, 0, 1)
    await page.keyboard.type('step two')
    await reopenPage(page, 'Getting Started')
    await expect(marker(rows(page).nth(0))).toHaveText('1.')
    await expect(marker(rows(page).nth(1))).toHaveText('2.')
    await expect(rows(page).nth(1)).toContainText('step two')

    // "2." → Enter → a styled, EMPTY "3.". It survives the blur because it
    // carries a property (the empty-block cleanup keeps blocks that carry
    // anything).
    await continueListFrom(page, 1, 2)
    await reopenPage(page, 'Getting Started')
    await expect(rows(page)).toHaveCount(SEED_ROWS + 2)
    await expect(marker(rows(page).nth(2))).toHaveText('3.')

    // Enter on the EMPTY third item: no fourth block, the item leaves the
    // list. Typing into it afterwards proves the caret never left it (and
    // keeps the now-plain empty block from the leaked-empty cleanup).
    await focusBlock(page, 2)
    await page.keyboard.press('Enter')
    await expect
      .poll(() => getInvokeCalls(page, 'delete_property'))
      .toMatchObject([{ key: 'listStyle' }])
    await expect(rows(page)).toHaveCount(SEED_ROWS + 2)
    await expect(editorIn(rows(page).nth(2))).toBeVisible()
    await page.keyboard.type('not a step')

    await reopenPage(page, 'Getting Started')
    await expect(rows(page)).toHaveCount(SEED_ROWS + 2)
    await expect(marker(rows(page).nth(0))).toHaveText('1.')
    await expect(marker(rows(page).nth(1))).toHaveText('2.')
    await expect(rows(page).nth(2)).toContainText('not a step')
    await expect(marker(rows(page).nth(2))).toHaveCount(0)
  })

  test('Backspace on an empty styled block clears the style, then deletes it', async ({ page }) => {
    await styleFirstBlockAsNumbered(page, 'step one')
    await reopenPage(page, 'Getting Started')
    await expect(marker(rows(page).nth(0))).toHaveText('1.')

    // "1." → Enter → an EMPTY styled "2.". An empty block has no ambiguous
    // caret position, so this Backspace path IS deterministic from outside.
    await continueListFrom(page, 0, 1)
    await reopenPage(page, 'Getting Started')
    await expect(rows(page)).toHaveCount(SEED_ROWS + 1)
    await expect(marker(rows(page).nth(1))).toHaveText('2.')

    // First Backspace: the style goes, the block stays.
    await focusBlock(page, 1)
    await page.keyboard.press('Backspace')
    await expect
      .poll(() => getInvokeCalls(page, 'delete_property'))
      .toMatchObject([{ key: 'listStyle' }])
    await expect(rows(page)).toHaveCount(SEED_ROWS + 1)
    await expect(page.getByTestId('list-marker')).toHaveCount(1)

    // Second Backspace on the now-plain empty block: the block goes.
    await page.keyboard.press('Backspace')
    await expect(rows(page)).toHaveCount(SEED_ROWS)

    await reopenPage(page, 'Getting Started')
    await expect(rows(page)).toHaveCount(SEED_ROWS)
    await expect(rows(page).nth(0)).toContainText('step one')
    await expect(marker(rows(page).nth(0))).toHaveText('1.')
  })
})
