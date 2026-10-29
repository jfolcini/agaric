import type { Locator, Page } from '@playwright/test'

import { expect, ipc, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * A page dragged from the sidebar's bookmarks, or from the recent pages, into
 * the editor becomes a `[[link]]` to it (#5691). In page mode it lands where
 * it is dropped; in block mode a static block takes it at its end. The
 * bookmarks reorder with dnd-kit's pointer drag, which cancels the native
 * drag, so a bookmark dropped outside the sidebar is handed to the drop target
 * as a native drop would be.
 *
 * Seed data (tauri-mock): "Getting Started" holds BLOCK01 and BLOCK02.
 */

const PROJECTS = '00000000000000000000PAGE04'
const BLOCK_GS_1 = '0000000000000000000BLOCK01'
const BLOCK_GS_2 = '0000000000000000000BLOCK02'
const GS_1_TEXT = 'Welcome to Agaric! This is your personal knowledge base.'
const PAGE_MODE_EDITOR = '[data-testid="page-mode-editor"]'

function staticBlock(page: Page, blockId: string): Locator {
  return page.locator(`[data-testid="block-static"][data-block-id="${blockId}"]`)
}

function bookmark(page: Page, title: string): Locator {
  return page
    .getByTestId('sidebar-bookmarks')
    .locator('[data-sidebar="menu-button"]', { hasText: title })
}

/** A mouse drag of `source` to the viewport point `(x, y)`. */
async function dragTo(page: Page, source: Locator, x: number, y: number): Promise<void> {
  const box = await source.boundingBox()
  if (!box) throw new Error('dragTo: the source has no layout box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 20 })
  await page.mouse.up()
}

/** The viewport point just inside the left edge of `word`, in the first text node of `scope`. */
function leftEdgeOf(scope: Locator, word: string): Promise<{ x: number; y: number }> {
  return scope.evaluate((root, w) => {
    const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode()
    const offset = node?.textContent?.indexOf(w) ?? -1
    if (node === null || offset < 0) throw new Error(`no "${w}" to drop at`)
    const range = document.createRange()
    range.setStart(node, offset)
    range.setEnd(node, offset + 1)
    const rect = range.getBoundingClientRect()
    return { x: rect.left + 1, y: rect.top + rect.height / 2 }
  }, word)
}

async function storedContent(page: Page, blockId: string): Promise<string> {
  return (await ipc<{ content: string }>(page, 'get_block', { blockId })).content
}

test.describe('A page dragged into the editor becomes a link (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await page.evaluate(
      (ids) => window.localStorage.setItem('starred-pages', JSON.stringify(ids)),
      [PROJECTS],
    )
    await waitForBoot(page)
  })

  test('a bookmark dropped on a block links the page at its end', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const block = staticBlock(page, BLOCK_GS_1)
    const box = await block.boundingBox()
    if (!box) throw new Error('the block has no layout box')

    await dragTo(page, bookmark(page, 'Projects'), box.x + 20, box.y + box.height / 2)

    await expect(
      staticBlock(page, BLOCK_GS_1).getByTestId('block-link-chip').filter({ hasText: 'Projects' }),
    ).toBeVisible()
    await expect.poll(() => storedContent(page, BLOCK_GS_1)).toBe(`${GS_1_TEXT} [[${PROJECTS}]]`)
    // A drag out of the list is no reorder, and opens nothing.
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')

    await reopenPage(page, 'Getting Started')
    await expect(
      staticBlock(page, BLOCK_GS_1).getByTestId('block-link-chip').filter({ hasText: 'Projects' }),
    ).toBeVisible()
  })

  test('a bookmark dropped in page mode links the page where it lands', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const first = page.locator(`${PAGE_MODE_EDITOR} [data-page-block-id="${BLOCK_GS_1}"]`)
    await expect(first).toContainText(GS_1_TEXT)
    const at = await leftEdgeOf(first.locator('.page-block-content'), 'This')
    await dragTo(page, bookmark(page, 'Projects'), at.x, at.y)

    await expect(first.getByTestId('block-link-chip').filter({ hasText: 'Projects' })).toBeVisible()
    await reopenPage(page, 'Getting Started')
    await expect
      .poll(() => storedContent(page, BLOCK_GS_1))
      .toBe(`Welcome to Agaric! [[${PROJECTS}]]This is your personal knowledge base.`)
  })

  test('a bookmark dropped on Edit as Markdown lands as the link where it lands', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Edit as Markdown', exact: true }).click()
    const buffer = page.getByRole('textbox', { name: 'Markdown source', exact: true })
    const line = buffer.locator(`[data-source-line][data-block-id="${BLOCK_GS_1}"]`)
    await expect(line).toHaveText(GS_1_TEXT)

    const at = await leftEdgeOf(line, 'This')
    await dragTo(page, bookmark(page, 'Projects'), at.x, at.y)

    await expect(line).toHaveText(
      `Welcome to Agaric! [[${PROJECTS}]]This is your personal knowledge base.`,
    )
  })

  test('a recent page dragged onto a block links it, through the native drag', async ({ page }) => {
    // The bookmark this describe adds also reads "Projects", so `openPage`'s
    // page-wide text match can find two; open the page through the bookmark.
    await bookmark(page, 'Projects').click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Projects')
    await openPage(page, 'Getting Started')
    const chip = page.getByTestId('quick-access-bar').getByRole('button', { name: 'Projects' })
    await expect(chip).toBeVisible()
    const block = staticBlock(page, BLOCK_GS_2)
    await expect(block).toBeVisible()

    await page.evaluate(
      ({ blockId }) => {
        const source = [
          ...document.querySelectorAll('[data-testid="quick-access-bar"] button'),
        ].find((button) => button.textContent === 'Projects')
        const target = document.querySelector(
          `[data-testid="block-static"][data-block-id="${blockId}"]`,
        )
        if (!source || !target) throw new Error('drag source or target not found')
        // `dragstart` runs the chip's own handler, which fills the transfer.
        const data = new DataTransfer()
        source.dispatchEvent(
          new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }),
        )
        for (const type of ['dragover', 'drop']) {
          target.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }),
          )
        }
      },
      { blockId: BLOCK_GS_2 },
    )

    await expect
      .poll(() => storedContent(page, BLOCK_GS_2))
      .toMatch(new RegExp(` \\[\\[${PROJECTS}\\]\\]$`))
    await reopenPage(page, 'Getting Started')
    await expect(
      staticBlock(page, BLOCK_GS_2).getByTestId('block-link-chip').filter({ hasText: 'Projects' }),
    ).toBeVisible()
  })
})
