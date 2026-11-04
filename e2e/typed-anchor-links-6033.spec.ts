import type { Page } from '@playwright/test'

import { blurEditors, expect, ipc, openPage, reopenPage, test, waitForBoot } from './helpers'

/**
 * #6033 — a typed `[[Page#Heading]]` keeps its anchor, against the mock
 * backend: the heading's block is stored as the block ref `((ULID))`, or for
 * `![[Page#Heading]]` alone in its block as the embed `{{embed ((ULID))}}`, in
 * block mode and in page mode. Durability is read back from the backend after
 * navigating away and back.
 *
 * The page "Target" is made per test: `# First`, `intro`, `## Second`.
 * "Quick Notes" (seed) hosts the block-mode edits.
 */

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

/** Make a page titled `title` holding `contents`, one block each; returns the block ids. */
async function makePage(
  page: Page,
  title: string,
  contents: string[],
): Promise<[string, string[]]> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const ids: string[] = []
  for (const content of contents) {
    const row = await ipc<{ id: string }>(page, 'create_block', {
      blockType: 'content',
      content,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
    ids.push(row.id)
  }
  return [pageId, ids]
}

/** The id of the "Target" page's `## Second` block. */
async function makeTarget(page: Page): Promise<string> {
  const [, ids] = await makePage(page, 'Target', ['# First', 'intro', '## Second'])
  return ids[2] as string
}

async function blockContent(page: Page, blockId: string): Promise<string | null> {
  return (await ipc<{ content: string | null }>(page, 'get_block', { blockId })).content
}

/** Open "Quick Notes", add a block, type `text` into it, leave it, and return its id. */
async function typeIntoNewBlock(page: Page, text: string): Promise<string> {
  await openPage(page, 'Quick Notes')
  await page.getByRole('button', { name: 'Add block' }).click()
  const editing = page.locator('[data-testid="sortable-block"]:has([data-testid="block-editor"])')
  const blockId = (await editing.getAttribute('data-block-id')) as string
  await page.keyboard.type(text, { delay: 30 })
  await expect(editing.locator('[data-testid="block-ref-chip"]')).toHaveCount(1)
  await blurEditors(page)
  return blockId
}

test.describe('a typed `[[Page#Heading]]` keeps its anchor (#6033) @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('in block mode, `[[Target#Second]]` refs the heading block', async ({ page }) => {
    const second = await makeTarget(page)
    const blockId = await typeIntoNewBlock(page, '[[Target#Second]]')

    await expect.poll(() => blockContent(page, blockId)).toBe(`((${second}))`)
    await reopenPage(page, 'Quick Notes')
    const host = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    await expect(host.getByTestId('block-ref-chip')).toContainText('Second')
    await expect.poll(() => blockContent(page, blockId)).toBe(`((${second}))`)
  })

  test('in block mode, `![[Target#Second]]` alone embeds the heading block', async ({ page }) => {
    const second = await makeTarget(page)
    const blockId = await typeIntoNewBlock(page, '![[Target#Second]]')

    const embed = `{{embed ((${second}))}}`
    const host = page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`)
    await expect(host.getByTestId('embed-container')).toContainText('Second')
    await expect.poll(() => blockContent(page, blockId)).toBe(embed)
    await reopenPage(page, 'Quick Notes')
    await expect(host.getByTestId('embed-container')).toContainText('Second')
    await expect.poll(() => blockContent(page, blockId)).toBe(embed)
  })

  test('in page mode, `[[Target#Second]]` refs the heading block', async ({ page }) => {
    const second = await makeTarget(page)
    const [, ids] = await makePage(page, 'Anchor host', ['', 'last'])
    await openPage(page, 'Anchor host')
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const editor = page.locator('[data-testid="page-mode-editor"]')
    await editor.locator(`[data-page-block-id="${ids[0]}"] .page-block-content`).click()
    // Keys typed before the editor holds the caret are lost.
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const anchor = document.getSelection()?.anchorNode
          const element = anchor instanceof Element ? anchor : anchor?.parentElement
          return element?.closest(`[data-page-block-id="${id}"]`) != null
        }, ids[0]),
      )
      .toBe(true)
    await page.keyboard.type('[[Target#Second]]', { delay: 30 })
    await expect(
      editor.locator(`[data-page-block-id="${ids[0]}"] [data-testid="block-ref-chip"]`),
    ).toHaveCount(1)
    // The block saves once the caret leaves it.
    await editor.locator(`[data-page-block-id="${ids[1]}"] .page-block-content`).click()

    await expect.poll(() => blockContent(page, ids[0] as string)).toBe(`((${second}))`)
    await page.keyboard.press('Escape')
    await reopenPage(page, 'Anchor host')
    await expect.poll(() => blockContent(page, ids[0] as string)).toBe(`((${second}))`)
  })
})
