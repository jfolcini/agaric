import type { Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  ipc,
  navigateToView,
  openPage,
  openSearchView,
  reopenPage,
  saveBlock,
  searchResultIds,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'

/**
 * Nested tags (#6760): a tag filter finds the tags named under it, in the
 * search view and in a query block, and the Tags view nests them.
 *
 * Seeded through the mock IPC: page `Nested Tags` holds one block per tag,
 * each with that tag attached.
 *
 *   On projects    projects
 *   On web         projects/web
 *   On site        projects/web/site
 *   On lookalike   projectsx
 *   On home        area/home      (no tag is named `area`)
 */

const PERSONAL = 'SPACE_PERSONAL'

async function seedNestedTags(page: Page): Promise<Record<string, string>> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: 'Nested Tags',
    spaceId: PERSONAL,
  })
  const create = async (blockType: 'content' | 'tag', content: string, parentId: string | null) =>
    (
      await ipc<{ id: string }>(page, 'create_block', {
        blockType,
        content,
        parentId,
        index: null,
        scope: { kind: 'active', space_id: PERSONAL },
        blockId: null,
      })
    ).id
  const blocks: Record<string, string> = {}
  for (const [content, tagName] of [
    ['On projects', 'projects'],
    ['On web', 'projects/web'],
    ['On site', 'projects/web/site'],
    ['On lookalike', 'projectsx'],
    ['On home', 'area/home'],
  ] as const) {
    const blockId = await create('content', content, pageId)
    await ipc(page, 'add_tag', { blockId, tagId: await create('tag', tagName, null) })
    blocks[content] = blockId
  }
  return blocks
}

const ids = (blocks: Record<string, string>, ...names: string[]) =>
  names.map((name) => blocks[name] ?? '').toSorted()

test.describe('Nested tags (#6760) @pages @search @editor', () => {
  test('a search on a tag finds the blocks of the tags under it', async ({ page }) => {
    await openSearchView(page)
    const blocks = await seedNestedTags(page)

    // Each query ends in a space: the caret then sits outside the tag token, so
    // Enter runs the search instead of accepting a tag suggestion.
    await submitSearch(page, 'tag:#projects ')
    await expect
      .poll(() => searchResultIds(page))
      .toEqual(ids(blocks, 'On projects', 'On web', 'On site'))

    await submitSearch(page, 'tag:#projects/web ')
    await expect.poll(() => searchResultIds(page)).toEqual(ids(blocks, 'On web', 'On site'))

    // No tag is named `area`: the name stands for the tags under it.
    await submitSearch(page, 'tag:#area ')
    await expect.poll(() => searchResultIds(page)).toEqual(ids(blocks, 'On home'))
  })

  test('a query block on a tag lists the blocks of the tags under it', async ({ page }) => {
    await waitForBoot(page)
    await seedNestedTags(page)
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.type('{{query tag:#projects}}', { delay: 20 })
    await saveBlock(page)
    const result = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="query-result"]')
    const items = result.getByTestId('query-result-item')
    await expect(items).toHaveText([/On site/, /On web/, /On projects/])

    await reopenPage(page, 'Getting Started')
    await expect(items).toHaveText([/On site/, /On web/, /On projects/])
  })

  test('the Tags view nests a tag under the name it shares a prefix with', async ({ page }) => {
    await waitForBoot(page)
    await seedNestedTags(page)
    await navigateToView(page, 'Tags')

    const row = (name: string) =>
      page.getByRole('listitem').filter({ has: page.getByTestId(`tag-item-${name}`) })
    await expect(row('projects')).toHaveAttribute('aria-level', '1')
    await expect(row('projects/web')).toHaveAttribute('aria-level', '2')
    await expect(row('projects/web/site')).toHaveAttribute('aria-level', '3')
    await expect(row('projectsx')).toHaveAttribute('aria-level', '1')
    await expect(row('area/home')).toHaveAttribute('aria-level', '2')
    // Under its parent a tag shows the last part of its name.
    await expect(page.getByTestId('tag-item-projects/web/site')).toHaveText(/^site/)
  })
})
