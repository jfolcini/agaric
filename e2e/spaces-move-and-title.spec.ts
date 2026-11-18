import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  expect,
  ipc,
  navigateToView,
  openPage,
  searchResultIds,
  settleBackend,
  submitSearch,
  switchToSpace,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5739 — a page moved to another space, and the window title.
 *
 * The page header's Move to space is `move_blocks_to_space`, which re-stamps `space_id` on the
 * page and every block of it and moves its `pages_cache` row; the Pages list, search and the Tags
 * view's usage counts all read those copies. `useAppSpaceLifecycle` titles the window
 * `<Page> · <Space> · Agaric` through the window plugin, read back here from the window.
 */

const PERSONAL = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

async function createBlock(page: Page, parentId: string, content: string): Promise<string> {
  const { id } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'content',
    content,
    parentId,
    index: null,
    scope: PERSONAL,
    blockId: null,
  })
  return id
}

/**
 * The open page's block rows in order: text before any tag chip, and nesting level. In Work the
 * Personal tag's chip shows its id: tags never cross spaces.
 */
function outline(page: Page): Promise<Array<{ text: string; level: string | null }>> {
  return page.locator('[data-testid="sortable-block"]').evaluateAll((rows) =>
    rows.map((row) => ({
      text: (row.textContent ?? '').split(' #')[0] ?? '',
      level: row.closest('li[aria-level]')?.getAttribute('aria-level') ?? null,
    })),
  )
}

/** The active space's Tags view row for `tag`: its name, then its usage count. */
async function tagUsage(page: Page, tag: string): Promise<string> {
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Tags')
  const row = page.getByTestId(`tag-item-${tag}`)
  await expect(row).toBeVisible()
  return (await row.textContent()) ?? ''
}

/** Search the active space for `word` from a freshly opened Search view. */
async function searchFor(page: Page, word: string): Promise<void> {
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Search')
  await submitSearch(page, word)
}

const windowTitle = (page: Page) => ipc<string>(page, 'plugin:window|title', { label: 'main' })

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('a page moved to Work takes its nested block: Pages, blocks and search follow, and its tag stops counting in Personal @spaces @pages', async ({
  page,
}) => {
  const create = (content: string) =>
    ipc<string>(page, 'create_page_in_space', {
      parentId: null,
      content,
      spaceId: SEED_IDS.SPACE_PERSONAL,
    })
  await create('Staying page')
  const movedId = await create('Moved page')
  const { id: tagId } = await ipc<{ id: string }>(page, 'create_block', {
    blockType: 'tag',
    content: 'movedtag',
    parentId: null,
    index: null,
    scope: PERSONAL,
    blockId: null,
  })
  const childId = await createBlock(page, movedId, `moved child #[${tagId}]`)
  const grandchildId = await createBlock(page, childId, 'zygomorphic grandchild')
  await settleBackend(page)
  expect(await tagUsage(page, 'movedtag')).toBe('movedtag1')

  await openPage(page, 'Moved page')
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Work', exact: true }).click()
  await expect(page.getByText('Page moved to Work')).toBeVisible()
  await settleBackend(page)

  // Personal: the page left its Pages list; the staying page says the list has loaded.
  await navigateToView(page, 'Journal')
  await navigateToView(page, 'Pages')
  await expect(page.locator('[data-page-title="Staying page"]')).toBeVisible()
  await expect(page.locator('[data-page-title="Moved page"]')).toHaveCount(0)

  // Work: listed, and both blocks came with it, nesting included.
  await switchToSpace(page, 'Work')
  await navigateToView(page, 'Pages')
  await page.locator('[data-page-title="Moved page"]').click()
  await expect
    .poll(() => outline(page))
    .toEqual([
      { text: 'moved child', level: '1' },
      { text: 'zygomorphic grandchild', level: '2' },
    ])

  // Search finds the nested block in Work and not in Personal.
  await searchFor(page, 'zygomorphic')
  await expect.poll(() => searchResultIds(page)).toEqual([grandchildId])
  await switchToSpace(page, 'Personal')
  await searchFor(page, 'zygomorphic')
  await expect(page.getByTestId('search-results-count')).toHaveText('No results')

  // The tag stays a Personal tag, and the moved block no longer counts toward it there.
  expect(await tagUsage(page, 'movedtag')).toBe('movedtag0')
})

test('titles the window <Page> · <Space> · Agaric, following the space and the page @spaces', async ({
  page,
}) => {
  await ipc(page, 'create_page_in_space', {
    parentId: null,
    content: 'Titled page',
    spaceId: SEED_IDS.SPACE_WORK,
  })
  await switchToSpace(page, 'Work')
  await openPage(page, 'Titled page')
  await expect.poll(() => windowTitle(page)).toBe('Titled page · Work · Agaric')

  await navigateToView(page, 'Pages')
  await expect.poll(() => windowTitle(page)).toBe('Pages · Work · Agaric')
  await switchToSpace(page, 'Personal')
  await navigateToView(page, 'Pages')
  await expect.poll(() => windowTitle(page)).toBe('Pages · Personal · Agaric')

  await switchToSpace(page, 'Work')
  await navigateToView(page, 'Pages')
  await page.locator('[data-page-title="Titled page"]').click()
  await expect.poll(() => windowTitle(page)).toBe('Titled page · Work · Agaric')
})
