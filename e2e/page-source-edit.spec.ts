import type { Locator, Page } from '@playwright/test'

import { activeDialog, expect, focusBlockById, openPage, test, waitForBoot } from './helpers'

/**
 * Source mode (#5140 Phase 4b): the page kebab's "Edit as Markdown" swaps the
 * block tree for the page's markdown buffer, and Save writes it back through
 * `apply_page_source`; Phase 5's Merge saves a stale buffer with the page's
 * changes folded in. Every assertion reads the block tree the save reloaded
 * from the mock. The Rust tests own the grammar; the real-backend twins are
 * `e2e-tauri/page-source-edit.e2e.ts` and `e2e-tauri/page-source-merge.e2e.ts`.
 */

const PAGE = 'Getting Started'
const GS1 = '0000000000000000000BLOCK01'
const GS2 = '0000000000000000000BLOCK02'
const GS3 = '0000000000000000000BLOCK03'
const GS4 = '0000000000000000000BLOCK04'
const GS5 = '0000000000000000000BLOCK05'
const WELCOME = 'Welcome to Agaric!'
const HELLO = 'Hello, Agaric!'

async function openSourceMode(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
  const editor = page.getByRole('textbox', { name: 'Markdown source', exact: true })
  await expect(editor).toHaveValue(new RegExp(`^- ${WELCOME} .* \\^${GS1}\n`))
  return editor
}

/** `source` with the bullets anchored at `a` and `b` swapped. */
function swapBullets(source: string, a: string, b: string): string {
  const lines = source.split('\n')
  const i = lines.findIndex((line) => line.endsWith(` ^${a}`))
  const j = lines.findIndex((line) => line.endsWith(` ^${b}`))
  const [lineA, lineB] = [lines[i] as string, lines[j] as string]
  lines[i] = lineB
  lines[j] = lineA
  return lines.join('\n')
}

function blockIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-block-id') ?? ''))
}

function staticBlock(page: Page, id: string): Locator {
  return page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)
}

// By test id, not role: while the conflict dialog is open Radix hides the
// textarea from the accessibility tree, so a role locator is already "hidden"
// before anything closes source mode.
function sourceEditor(page: Page): Locator {
  return page.getByTestId('page-source-editor')
}

async function editBlockElsewhere(page: Page, blockId: string, toText: string): Promise<void> {
  await page.evaluate(
    async ({ id, text }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      await invoke('edit_block', { blockId: id, toText: text })
    },
    { id: blockId, text: toText },
  )
}

test.describe('Edit as Markdown (#5140 Phase 4b)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await expect(staticBlock(page, GS1)).toBeVisible()
  })

  test('Save writes an edited and reordered buffer, and the tree shows it', async ({ page }) => {
    const editor = await openSourceMode(page)
    const base = await editor.inputValue()

    await editor.fill(swapBullets(base, GS1, GS3).replace(WELCOME, HELLO))
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect.poll(() => blockIds(page)).toEqual([GS3, GS2, GS1, GS4, GS5])
    await expect(staticBlock(page, GS1)).toContainText(HELLO)
  })

  test('a page changed since opening asks first, and Overwrite keeps the buffer', async ({
    page,
  }) => {
    const elsewhere = 'Edited on another device'
    const editor = await openSourceMode(page)
    await editBlockElsewhere(page, GS3, elsewhere)
    await editor.fill((await editor.inputValue()).replace(WELCOME, HELLO))

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    const dialog = activeDialog(page)
    await expect(dialog.getByRole('heading', { name: 'This page changed' })).toBeVisible()
    await expect(dialog.getByRole('listitem')).toHaveCount(1)
    await expect(dialog.getByRole('listitem')).toContainText(elsewhere)
    await dialog.getByRole('button', { name: 'Overwrite', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(staticBlock(page, GS1)).toContainText(HELLO)
    await expect(staticBlock(page, GS3)).toContainText('Create new blocks')
    await expect(page.getByText(elsewhere)).toHaveCount(0)
  })

  test('Merge saves the buffer with the change made since opening folded in', async ({ page }) => {
    const elsewhere = 'Edited on another device'
    const editor = await openSourceMode(page)
    await editBlockElsewhere(page, GS3, elsewhere)
    await editor.fill((await editor.inputValue()).replace(WELCOME, HELLO))

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await activeDialog(page).getByRole('button', { name: 'Merge', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect(staticBlock(page, GS1)).toContainText(HELLO)
    await expect(staticBlock(page, GS3)).toContainText(elsewhere)
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4, GS5])
  })

  // Opening the kebab blurs the editor, which commits the block before the
  // buffer is read; no flush of the focused block is left to do.
  test('what was just typed into a block is in the buffer', async ({ page }) => {
    await focusBlockById(page, GS1)
    await page.keyboard.press('End')
    await page.keyboard.type(' Typed just now.')

    const editor = await openSourceMode(page)

    await expect(editor).toHaveValue(new RegExp(`knowledge base\\. Typed just now\\. \\^${GS1}\n`))
  })

  test('Cancel leaves the page untouched', async ({ page }) => {
    const editor = await openSourceMode(page)
    await editor.fill(swapBullets(await editor.inputValue(), GS1, GS3).replace(WELCOME, HELLO))

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()

    await expect(sourceEditor(page)).toHaveCount(0)
    await expect.poll(() => blockIds(page)).toEqual([GS1, GS2, GS3, GS4, GS5])
    await expect(staticBlock(page, GS1)).toContainText(WELCOME)
  })
})
