import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeDialog,
  activePopover,
  activeSuggestionPopup,
  blurEditors,
  chooseSelectOption,
  expect,
  focusBlock,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  saveBlock,
  switchToSpace,
  test,
  waitForBoot,
} from './helpers'

/**
 * The Tags view and the page-header tag row across the lifecycle of a tag:
 *
 *  - #5257: the Tags view stays mounted across a space switch (each space
 *    remembers its view) and must list the space switched back to.
 *  - #5254: renaming or deleting a tag in the list relabels or drops its chip
 *    in the filter panel below.
 *  - #5236: a tag created from the page header is the one a later `#name` in
 *    a block applies, not a second tag of the same name.
 *  - #5244: an applied tag outside the space's 50 oldest still gets its chip.
 *  - #5366: a rename relabels the list, its count and the chips in blocks.
 *  - #4671: an `@` picker create lists the tag in its own space only, and
 *    the Pages batch toolbar tags every selected page.
 */

const PERSONAL = SEED_IDS.SPACE_PERSONAL
const WORK = SEED_IDS.SPACE_WORK
const GETTING_STARTED = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000B10CK01'
const TAG_REF = /#\[([0-9A-Z]{26})\]/

interface TagRow {
  tag_id: string
  name: string
}

function tagsInSpace(page: Page, spaceId: string): Promise<TagRow[]> {
  return ipc<TagRow[]>(page, 'list_all_tags_in_space', {
    scope: { kind: 'active', space_id: spaceId },
  })
}

/** The tag the first `#[ULID]` in block GS1 points at. */
async function storedTagId(page: Page): Promise<string | undefined> {
  const { content } = await ipc<{ content: string }>(page, 'get_block', { blockId: GS1 })
  return content.match(TAG_REF)?.[1]
}

/** The remove button of the `name` chip (filter panel or page header). */
function removeChip(page: Page, name: string) {
  return page.getByRole('button', { name: `Remove tag ${name}`, exact: true })
}

/** The Tags-view row holding `name`. */
function tagRow(page: Page, name: string) {
  return page
    .locator('[data-slot="list-item"]')
    .filter({ has: page.getByTestId(`tag-item-${name}`) })
}

/** A page titled `title` in `spaceId` holding one block `content`; returns the page id. */
async function seedPage(
  page: Page,
  spaceId: string,
  title: string,
  content: string,
): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId,
  })
  await ipc(page, 'create_blocks_batch', {
    specs: [{ blockType: 'content', content, parentId: pageId, position: null }],
  })
  return pageId
}

/** The usage count the Tags list shows for `name`, after leaving the view and coming back. */
async function expectListedCount(page: Page, name: string, count: string): Promise<void> {
  // The count is `tags_cache`, which the materializer writes after the change.
  await expect(async () => {
    await navigateToView(page, 'Journal')
    await navigateToView(page, 'Tags')
    await expect(
      page.getByTestId(`tag-item-${name}`).locator('[data-slot="badge"] > span:last-child'),
    ).toHaveText(count, { timeout: 2_000 })
  }).toPass()
}

async function createTagInList(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder('New tag name...').fill(name)
  await page.getByRole('button', { name: 'Add tag' }).click()
  await expect(page.getByTestId(`tag-item-${name}`)).toBeVisible()
}

test.describe('Tags view follows the active space (#5257) @pages @spaces', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('switching back lists that space, and a delete purges only its tag', async ({ page }) => {
    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-idea')).toBeVisible()

    await switchToSpace(page, 'Work')
    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-idea')).toHaveCount(0)
    await createTagInList(page, 'worktag')

    // Personal remembers the Tags view, so the view stays mounted.
    await switchToSpace(page, 'Personal')
    await expect(page.getByTestId('tag-item-idea')).toBeVisible()
    await expect(page.getByTestId('tag-item-worktag')).toHaveCount(0)

    const row = tagRow(page, 'idea')
    await row.hover()
    await row.getByRole('button', { name: 'Delete tag' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByTestId('tag-item-idea')).toHaveCount(0)

    await expect
      .poll(async () => (await tagsInSpace(page, PERSONAL)).map((t) => t.name))
      .not.toContain('idea')
    await switchToSpace(page, 'Work')
    await expect(page.getByTestId('tag-item-worktag')).toBeVisible()
  })
})

test.describe('Filter panel follows the Tags list (#5254) @pages @spaces', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Tags')
    await page.getByLabel('Find a tag').fill('ide')
    const matching = page.getByRole('grid', { name: 'Matching tags', exact: true })
    await matching.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(removeChip(page, 'idea')).toBeVisible()
  })

  test('renaming a selected tag relabels its chip', async ({ page }) => {
    const row = tagRow(page, 'idea')
    await row.hover()
    await row.getByRole('button', { name: 'Rename tag' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('New tag name').fill('concept')
    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByTestId('tag-item-concept')).toBeVisible()
    await expect(removeChip(page, 'concept')).toBeVisible()
    await expect(removeChip(page, 'idea')).toHaveCount(0)
  })

  test('deleting a selected tag drops its chip', async ({ page }) => {
    const row = tagRow(page, 'idea')
    await row.hover()
    await row.getByRole('button', { name: 'Delete tag' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    await expect(page.getByTestId('tag-item-idea')).toHaveCount(0)
    await expect(removeChip(page, 'idea')).toHaveCount(0)
    await expect(page.getByText('Selected:')).toHaveCount(0)
  })
})

test.describe('Page-header tags (#5236, #5244) @pages @spaces', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a tag created in the header is the one a typed #name applies', async ({ page }) => {
    await ipc(page, 'edit_block', { blockId: GS1, toText: 'Plan' })
    await openPage(page, 'Getting Started')

    // Warm this tree's `#` picker cache BEFORE the header create, so the
    // later `#launch` is answered from the cache the create must reach.
    const editor = await focusBlockById(page, GS1)
    await editor.press('End')
    await page.keyboard.type(' #wor', { delay: 30 })
    await expect(activeSuggestionPopup(page)).toBeVisible()
    for (let i = 0; i < ' #wor'.length; i += 1) await page.keyboard.press('Backspace')
    await expect(activeSuggestionPopup(page)).not.toBeVisible()
    await blurEditors(page)

    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add tag', exact: true }).click()
    await activePopover(page).getByLabel('Search tags').fill('launch')
    await activePopover(page).getByRole('button', { name: 'Create "launch"' }).click()
    await expect(removeChip(page, 'launch')).toBeVisible()

    const typed = await focusBlockById(page, GS1)
    await typed.press('End')
    await page.keyboard.type(' #launch ', { delay: 30 })
    await expect(typed.getByTestId('tag-ref-chip')).toHaveCount(1)
    await saveBlock(page)

    await expect.poll(() => storedTagId(page)).toBeDefined()
    const launch = (await tagsInSpace(page, PERSONAL)).filter((t) => t.name === 'launch')
    expect(launch).toHaveLength(1)
    expect(await storedTagId(page)).toBe(launch[0]?.tag_id)

    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-launch')).toHaveCount(1)
  })

  test('an applied tag newer than the 50 oldest in the space shows its chip', async ({ page }) => {
    let newest = ''
    for (let i = 1; i <= 50; i += 1) {
      const created = await ipc<{ id: string }>(page, 'create_block', {
        blockType: 'tag',
        content: `bulk-${String(i).padStart(2, '0')}`,
        parentId: null,
        index: null,
        scope: { kind: 'active', space_id: PERSONAL },
        blockId: null,
      })
      newest = created.id
    }
    await ipc(page, 'add_tag', { blockId: GETTING_STARTED, tagId: newest })

    await openPage(page, 'Getting Started')

    await expect(removeChip(page, 'bulk-50')).toBeVisible()
  })
})

test.describe('A tag across pages and spaces (#5366, #4671) @pages @spaces', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a rename relabels the list, keeps its count, and relabels the chip in a block', async ({
    page,
  }) => {
    await navigateToView(page, 'Tags')
    await createTagInList(page, 'usagetag')
    await expectListedCount(page, 'usagetag', '0')
    const tag = (await tagsInSpace(page, PERSONAL)).find((t) => t.name === 'usagetag')
    await seedPage(page, PERSONAL, 'Usage page', `tagged line #[${tag?.tag_id}]`)
    await expectListedCount(page, 'usagetag', '1')

    const row = tagRow(page, 'usagetag')
    await row.hover()
    await row.getByRole('button', { name: 'Rename tag' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('New tag name').fill('renamedtag')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Tag renamed successfully.')).toBeVisible()

    await expectListedCount(page, 'renamedtag', '1')
    await expect(page.getByTestId('tag-item-usagetag')).toHaveCount(0)
    await openPage(page, 'Usage page')
    await expect(
      page
        .getByTestId('block-static')
        .filter({ hasText: 'tagged line' })
        .getByTestId('tag-ref-chip'),
    ).toHaveText(['renamedtag'])
  })

  test('a tag created from the @ picker is listed in its own space only', async ({ page }) => {
    await switchToSpace(page, 'Work')
    await seedPage(page, WORK, 'Work notes', 'scoped')
    await openPage(page, 'Work notes')
    const editor = await focusBlock(page)
    await editor.press('End')
    await page.keyboard.type(' @scopedtag', { delay: 30 })
    // The picker answers after each key: Enter waits for the full term's Create item.
    const first = activeSuggestionPopup(page).getByTestId('suggestion-item').first()
    await expect(first).toHaveText(/Create.*scopedtag/)
    await page.keyboard.press('Enter')
    await expect(editor.getByTestId('tag-ref-chip')).toHaveText(['scopedtag'])
    await saveBlock(page)

    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-scopedtag')).toBeVisible()
    await expect
      .poll(async () => (await tagsInSpace(page, WORK)).map((t) => t.name))
      .toContain('scopedtag')
    expect((await tagsInSpace(page, PERSONAL)).map((t) => t.name)).not.toContain('scopedtag')

    await switchToSpace(page, 'Personal')
    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-idea')).toBeVisible()
    await expect(page.getByTestId('tag-item-scopedtag')).toHaveCount(0)

    await switchToSpace(page, 'Work')
    await navigateToView(page, 'Journal')
    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-scopedtag')).toBeVisible()
  })

  test('the Pages batch toolbar tags every selected page', async ({ page }) => {
    const titles = ['Batch one', 'Batch two', 'Batch six']
    const ids = await Promise.all(titles.map((title) => seedPage(page, PERSONAL, title, 'body')))
    await navigateToView(page, 'Pages')
    for (const id of ids) {
      await page.getByTestId(`page-select-${id}`).click({ modifiers: ['ControlOrMeta'] })
    }
    const toolbar = page.getByRole('toolbar', { name: '3 selected', exact: true })
    await toolbar.getByRole('button', { name: 'Add tag', exact: true }).click()
    await chooseSelectOption(page, 'Choose a tag…', 'idea')
    await toolbar.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByText('Tagged 3 pages')).toBeVisible()

    await navigateToView(page, 'Journal')
    for (const title of titles) {
      await openPage(page, title)
      await expect(removeChip(page, 'idea')).toBeVisible()
    }
    for (const blockId of ids) {
      expect(await ipc<string[]>(page, 'list_tags_for_block', { blockId })).toEqual([
        SEED_IDS.TAG_IDEA,
      ])
    }
  })
})
