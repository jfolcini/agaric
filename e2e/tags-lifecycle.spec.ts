import type { Page } from '@playwright/test'

import {
  activeDialog,
  activePopover,
  activeSuggestionPopup,
  blurEditors,
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  saveBlock,
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
 */

const PERSONAL = 'SPACE_PERSONAL'
const GETTING_STARTED = '00000000000000000000PAGE01'
const GS1 = '0000000000000000000BLOCK01'
const TAG_REF = /#\[([0-9A-Z]{26})\]/

interface TagRow {
  tag_id: string
  name: string
}

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

async function switchToSpace(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Switch space', exact: true }).click()
  // The trigger's hover tooltip can cover the option list (see
  // spaces-management.spec.ts); move off it before choosing.
  await page.mouse.move(0, 0)
  await page.getByRole('option', { name, exact: true }).click()
}

/** Create a space in Settings › Spaces; the app stays on Settings and on the active space. */
async function createSpace(page: Page, name: string): Promise<void> {
  await page.getByRole('combobox', { name: 'Switch space', exact: true }).click()
  await page.mouse.move(0, 0)
  await page.getByRole('option', { name: 'Manage spaces…', exact: true }).click()
  const panel = page.getByTestId('settings-panel-spaces')
  await panel.getByRole('button', { name: 'Create new space', exact: true }).click()
  await panel.getByPlaceholder('New space name').fill(name)
  await panel.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: 'Rename space' }).last()).toHaveValue(name)
}

async function createTagInList(page: Page, name: string): Promise<void> {
  await page.getByPlaceholder('New tag name...').fill(name)
  await page.getByRole('button', { name: 'Add Tag' }).click()
  await expect(page.getByTestId(`tag-item-${name}`)).toBeVisible()
}

test.describe('Tags view follows the active space (#5257)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('switching back lists that space, and a delete purges only its tag', async ({ page }) => {
    await createSpace(page, 'Work')
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

test.describe('Filter panel follows the Tags list (#5254)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Tags')
    await page.getByLabel('Search tags by prefix').fill('ide')
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

test.describe('Page-header tags (#5236, #5244)', () => {
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
