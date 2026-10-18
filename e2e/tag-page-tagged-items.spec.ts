import type { Page } from '@playwright/test'

import {
  activePopover,
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * A tag's page lists what the tag is on: the pages tagged with it and the
 * blocks tagged with it directly, attached or written inline as `#idea`. A
 * block that only inherits the tag, from its page or from a tagged ancestor
 * block, is not listed. The Tags list counts the same set.
 *
 * Seeded through the mock IPC, then tagged through the UI where the UI can:
 *
 *   Tagged Page (page)          idea, from the page header
 *     Under tagged page
 *   Plain Page (page)
 *     Attached                  idea, attached (add_tag)
 *       Under tagged block
 *     Inline                    idea, typed as #idea
 */

const PERSONAL = 'SPACE_PERSONAL'

function ipc<T>(page: Page, cmd: string, args: unknown): Promise<T> {
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

function createPage(page: Page, title: string): Promise<string> {
  return ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: PERSONAL,
  })
}

async function createBlock(page: Page, content: string, parentId: string): Promise<string> {
  const row = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: { kind: 'active', space_id: PERSONAL },
    blockId: null,
  })
  return row.id
}

async function openTag(page: Page, name: string): Promise<void> {
  await navigateToView(page, 'Tags')
  await page.getByTestId(`tag-item-${name}`).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(name)
}

test.describe('A tag page lists what the tag is on @pages', () => {
  test('pages and directly tagged blocks, not blocks that inherit the tag', async ({ page }) => {
    await waitForBoot(page)
    const taggedPage = await createPage(page, 'Tagged Page')
    await createBlock(page, 'Under tagged page', taggedPage)
    const plainPage = await createPage(page, 'Plain Page')
    const attached = await createBlock(page, 'Attached', plainPage)
    await createBlock(page, 'Under tagged block', attached)
    const inline = await createBlock(page, 'Inline', plainPage)
    const tags = await ipc<{ tag_id: string; name: string }[]>(page, 'list_all_tags_in_space', {
      scope: { kind: 'active', space_id: PERSONAL },
    })
    const idea = tags.find((t) => t.name === 'idea')?.tag_id as string
    await ipc(page, 'add_tag', { blockId: attached, tagId: idea })

    await openPage(page, 'Tagged Page')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add tag', exact: true }).click()
    await activePopover(page).getByLabel('Search tags').fill('idea')
    await activePopover(page).getByRole('button', { name: 'idea', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove tag idea', exact: true })).toBeVisible()

    await openPage(page, 'Plain Page')
    const editor = await focusBlockById(page, inline)
    await editor.press('End')
    await page.keyboard.type(' #idea ', { delay: 30 })
    await expect(editor.getByTestId('tag-ref-chip')).toHaveCount(1)
    await saveBlock(page)

    await navigateToView(page, 'Tags')
    // The Tags list counts the tagged page and the two tagged blocks.
    await expect(page.getByTestId('tag-item-idea')).toHaveText('idea3')
    await openTag(page, 'idea')

    const pages = page.getByRole('region', { name: 'Pages', exact: true })
    const blocks = page.getByRole('region', { name: 'Blocks', exact: true })
    await expect(pages.getByRole('listitem')).toHaveText(['Tagged Page'])
    // Newest first: the inline block was created after the attached one.
    await expect(blocks.locator('[data-backlink-item]')).toHaveText([/^Inline/, 'Attached'])
    await expect(blocks.getByRole('link', { name: 'Plain Page', exact: true })).toBeVisible()
    await expect(blocks.getByText('Under tagged page')).toHaveCount(0)
    await expect(blocks.getByText('Under tagged block')).toHaveCount(0)
    await expect(blocks.getByText('Tagged Page')).toHaveCount(0)

    await blocks.locator(`[data-backlink-item="${attached}"]`).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Plain Page')
    await expect(page.locator(`[data-block-id="${attached}"]`).first()).toBeVisible()
  })

  test('expands a tagged block, and searches everything under the tag', async ({ page }) => {
    await waitForBoot(page)
    const tags = await ipc<{ tag_id: string; name: string }[]>(page, 'list_all_tags_in_space', {
      scope: { kind: 'active', space_id: PERSONAL },
    })
    const idea = tags.find((t) => t.name === 'idea')?.tag_id as string
    const taggedPage = await createPage(page, 'Tagged Page')
    await createBlock(page, 'Under tagged page', taggedPage)
    await ipc(page, 'add_tag', { blockId: taggedPage, tagId: idea })
    const plainPage = await createPage(page, 'Plain Page')
    const attached = await createBlock(page, 'Attached', plainPage)
    await createBlock(page, 'Under tagged block', attached)
    await ipc(page, 'add_tag', { blockId: attached, tagId: idea })
    await createBlock(page, `Inline #[${idea}]`, plainPage)
    await createBlock(page, 'Untagged', plainPage)

    await openTag(page, 'idea')
    const blocks = page.getByRole('region', { name: 'Blocks', exact: true })
    const attachedRow = blocks.locator(`[data-backlink-item="${attached}"]`)
    await attachedRow.getByRole('button', { name: 'Show child blocks' }).click()
    await expect(attachedRow.getByText('Under tagged block')).toBeVisible()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('idea')

    await page.getByRole('button', { name: 'Search everything under #idea' }).click()
    await expect(page.getByPlaceholder('Search blocks...')).toHaveValue('under:#idea')
    const results = page.getByTestId('search-result-region').getByRole('option')
    // The tagged page, the attached and the inline block, and the two blocks
    // that only inherit the tag, the first from its page.
    await expect(results).toHaveCount(5)
    for (const text of ['Tagged Page', 'Under tagged page', 'Attached', 'Under tagged block']) {
      await expect(results.filter({ hasText: text }).first()).toBeVisible()
    }
    await expect(results.filter({ hasText: 'Untagged' })).toHaveCount(0)
  })

  test('says so in each panel when nothing carries the tag', async ({ page }) => {
    await waitForBoot(page)
    await openTag(page, 'idea')

    await expect(page.getByText('No pages have this tag.')).toBeVisible()
    await expect(page.getByText('No blocks have this tag.')).toBeVisible()
  })
})
