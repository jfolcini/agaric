import type { Page } from '@playwright/test'

import {
  activeSuggestionList,
  blurEditors,
  expect,
  ipc,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5691 — Obsidian's `![[` embed syntax and its quick switcher's create row,
 * against the mock backend. Typing `![[` opens the `[[` page picker; the pick
 * is stored as Agaric's own embed, `{{embed [[ULID]]}}`, and renders as one,
 * in block mode and in page mode. Durability is read back from the backend and
 * shown again after navigating away and back.
 *
 * Seed data (`src/lib/tauri-mock/seed.ts`): "Getting Started" (PAGE01), whose
 * first block is "Welcome to Agaric! …"; "Quick Notes" is the host page.
 */

const GETTING_STARTED = '00000000000000000000PAGE01'
const EMBED = `{{embed [[${GETTING_STARTED}]]}}`
const WELCOME = 'Welcome to Agaric!'
const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

/** Type `![[Getting` in the focused editor and pick "Getting Started" from the `[[` picker. */
async function embedGettingStarted(page: Page): Promise<void> {
  await page.keyboard.type('![[Getting')
  const list = activeSuggestionList(page)
  await expect(list).toBeVisible()
  await list.getByRole('option').filter({ hasText: 'Getting Started' }).first().click()
}

async function blockContent(page: Page, blockId: string): Promise<string | null> {
  return (await ipc<{ content: string | null }>(page, 'get_block', { blockId })).content
}

test.describe('typing `![[` embeds a page (#5691) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('in block mode, the picked page renders as an embed and stays one', async ({ page }) => {
    await openPage(page, 'Quick Notes')
    // An embed is the block's whole content, so start from a fresh block.
    await page.getByRole('button', { name: 'Add block' }).click()
    const editing = page.locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
    const blockId = (await editing.getAttribute('data-block-id')) as string

    await embedGettingStarted(page)
    await blurEditors(page)

    const host = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    await expect(host.getByTestId('embed-container')).toContainText(WELCOME)
    await expect.poll(() => blockContent(page, blockId)).toBe(EMBED)

    await reopenPage(page, 'Quick Notes')
    await expect(host.getByTestId('embed-container')).toContainText(WELCOME)
  })

  test('in page mode, the picked page renders as an embed and stays one', async ({ page }) => {
    const pageId = await ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content: 'Embed host',
      spaceId: SCOPE.space_id,
    })
    const ids: string[] = []
    for (const content of ['first', 'last']) {
      const row = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'content',
        content,
        parentId: pageId,
        index: null,
        scope: SCOPE,
      })
      ids.push(row.id)
    }
    await openPage(page, 'Embed host')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const editor = page.locator('[data-testid="page-mode-editor"]')
    const first = editor.locator(`[data-page-block-id="${ids[0]}"] .page-block-content`)
    await expect(first).toHaveText('first')

    await first.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await embedGettingStarted(page)
    // The embed renders once the caret leaves its block.
    await editor.locator(`[data-page-block-id="${ids[1]}"] .page-block-content`).click()

    await expect(editor.getByTestId('embed-container')).toContainText(WELCOME)
    const texts = async () => {
      const { blocks } = await ipc<{
        blocks: Array<{ parent_id: string; position: number; content: string | null }>
      }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
      return blocks
        .filter((b) => b.parent_id === pageId)
        .toSorted((a, b) => a.position - b.position)
        .map((b) => b.content)
    }
    await expect.poll(texts).toEqual(['first', EMBED, 'last'])

    await page.keyboard.press('Escape')
    await reopenPage(page, 'Embed host')
    await expect(page.getByTestId('embed-container')).toContainText(WELCOME)
  })
})

test.describe('the command palette creates a page nothing matches (#5691) @search @pages', () => {
  test('a query with no match offers Create page, which opens the new page', async ({ page }) => {
    await waitForBoot(page)
    await page.keyboard.press('Control+k')
    await page.getByTestId('command-palette-input').fill('Zebra migration plan')
    await expect(page.getByTestId('palette-no-results')).toBeVisible()
    // The first row when nothing matches, so Enter picks it.
    await expect(
      page.getByRole('option', { name: 'Create page “Zebra migration plan”' }),
    ).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('Enter')

    // The New page dialog every new-page entry point opens, holding the query.
    const title = page
      .getByTestId('new-page-dialog')
      .getByRole('textbox', { name: 'New page title' })
    await expect(title).toHaveValue('Zebra migration plan')
    await expect(title).toBeFocused()
    await page.keyboard.press('Enter')

    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Zebra migration plan')
    const pages = await ipc<Array<{ content: string | null }>>(page, 'list_all_pages_in_space', {
      scope: SCOPE,
      tagIds: null,
    })
    expect(pages.filter((p) => p.content === 'Zebra migration plan')).toHaveLength(1)
  })
})
