import { devices } from '@playwright/test'

import { expect, focusBlock, openPage, saveBlock, test, waitForBoot } from './helpers'

/**
 * E2E for #5160 D2 — a line break inside a block.
 *
 * A stored `hello\nworld` (from Source, import or paste — Rust reads it as one
 * block with two lines) used to parse in the editor as two paragraphs, so the
 * first blur after a typo fix split the block into siblings (X1). Now a single
 * `\n` is a line of the same paragraph, shown as a break at rest, and the blur
 * splits only what the edit ADDED. Phones get the Shift+Enter action as a
 * toolbar button.
 *
 * The desktop test seeds the content through the mock's `edit_block` IPC —
 * exactly the shape a Source-mode save or an import stores — and re-queries
 * the block through `get_block` after the blur (durable state, not call
 * shape).
 */

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
type Page = import('@playwright/test').Page

// Seed id from src/lib/tauri-mock/seed.ts (BLOCK_GS_1, the first content
// block of the "Getting Started" page).
const BLOCK_GS_1 = '0000000000000000000BLOCK01'

function invokeIn(page: Page): Invoke {
  return (cmd, args) =>
    page.evaluate(
      (call) => {
        const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } })
          .__TAURI_INTERNALS__.invoke
        return invoke(call.cmd, call.args)
      },
      { cmd, args },
    )
}

async function blockContent(page: Page, blockId: string): Promise<string> {
  const row = (await invokeIn(page)('get_block', { blockId })) as { content: string }
  return row.content
}

/**
 * After seeding, re-enter the page so the block list re-reads the store and
 * the static block re-renders (the mock persists across in-app navigation;
 * only a reload reseeds it). The recents bar is the one unambiguous locator
 * back to Getting Started — see nested-list-blur-1513.spec.ts.
 */
async function reopenGettingStarted(page: Page): Promise<void> {
  await openPage(page, 'Quick Notes')
  await page
    .getByTestId('quick-access-bar')
    .getByRole('button', { name: 'Getting Started' })
    .click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

test.describe('A line break inside a block (#5160 D2)', () => {
  test('a stored two-line block stays one block after a typo fix and a blur', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await invokeIn(page)('edit_block', { blockId: BLOCK_GS_1, toText: 'hello\nworld' })
    await reopenGettingStarted(page)

    const rows = page.locator('[data-testid="sortable-block"]')
    const rowCount = await rows.count()
    const first = rows.first().locator('[data-testid="block-static"]')
    // At rest the break is visible, not a space.
    await expect(first.locator('br')).toHaveCount(1)
    await expect(first).toHaveText('helloworld')

    await focusBlock(page, 0)
    await page.keyboard.press('Control+End')
    await page.keyboard.type('!')
    // A genuine blur (focus leaves the editor for another block's static
    // surface): the classifying flush, not Escape's discard.
    await rows.nth(1).locator('[data-testid="block-static"]').click()
    await expect(first).toBeVisible()

    await expect(rows).toHaveCount(rowCount)
    await expect(first.locator('br')).toHaveCount(1)
    expect(await blockContent(page, BLOCK_GS_1)).toBe('hello\nworld!')
  })

  test('a stored two-paragraph block is not rewritten by a focus and a blur with no edit', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await invokeIn(page)('edit_block', { blockId: BLOCK_GS_1, toText: 'hello\n\nworld' })
    await reopenGettingStarted(page)

    const rows = page.locator('[data-testid="sortable-block"]')
    const first = rows.first().locator('[data-testid="block-static"]')
    // Two paragraphs at rest: a gap between them, no line break.
    await expect(first).toHaveText('hello world')
    await expect(first.locator('br')).toHaveCount(0)

    await focusBlock(page, 0)
    await rows.nth(1).locator('[data-testid="block-static"]').click()
    await expect(first).toBeVisible()

    // The blank line is a paragraph separator, not a line break to fold: the
    // editor's own paragraphs (schema default `todoState: null`) serialize as
    // the parser reads them, so nothing is written and no break appears.
    await expect(first).toHaveText('hello world')
    await expect(first.locator('br')).toHaveCount(0)
    expect(await blockContent(page, BLOCK_GS_1)).toBe('hello\n\nworld')
  })
})

const iPhone13 = devices['iPhone 13']

test.describe('The toolbar New line button (iPhone 13 viewport)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('tapping New line inserts a line break the block keeps', async ({ page }) => {
    // The default boot (Journal) view's seeded day already has editable blocks.
    await waitForBoot(page)
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()

    const editor = await focusBlock(page, 0)
    const blockId = await page
      .locator('[data-testid="block-editor"]')
      .first()
      .getAttribute('data-block-id')
    expect(blockId).not.toBeNull()

    // `focusBlock` leaves the caret at the end of the block's text.
    await page.keyboard.type('one')
    const newLine = page.getByTestId('formatting-toolbar').getByRole('button', { name: 'New line' })
    // Directly on the pinned bar, not behind the overflow "More" menu.
    await expect(newLine).toBeVisible()
    await newLine.tap()
    await page.keyboard.type('two')
    // Counted after the second line exists: ProseMirror pads a break at the end
    // of a paragraph with a trailing placeholder `<br>` for the caret.
    await expect(editor.locator('br')).toHaveCount(1)

    // Enter at the end commits the block and moves on; the block keeps both
    // lines instead of being split.
    await saveBlock(page, 'Enter')
    const content = await blockContent(page, blockId as string)
    expect(content.endsWith('one\ntwo')).toBe(true)
    const committed = page.locator(
      `[data-testid="sortable-block"][data-block-id="${blockId as string}"] [data-testid="block-static"]`,
    )
    await expect(committed.locator('br')).toHaveCount(1)
  })
})
