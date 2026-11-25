import type { Locator, Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeAlertDialog,
  activeDialog,
  blurEditors,
  expect,
  focusBlockById,
  ipc,
  navigateToView,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6755, mock lane: a tag's page is written on. "Add notes" on a tag's page
 * makes the page `Tag/<tag>` through the tag and lands the caret in its first
 * block; what is typed there is the page's block, shown on the tag's page and
 * on the page itself, which links back to its tag. The tag and its page are
 * renamed together from either one and reverted together from History. A
 * typed `[[Tag/x]]` naming no page makes tag `x` and its page, as `#x` makes
 * the tag; the New page dialog makes no page under `Tag/`.
 *
 * Persistence is read back from the backend after navigating away and back.
 */

const SCOPE = { kind: 'active', space_id: SEED_IDS.SPACE_PERSONAL }

/** The page titled `title` in the space, as `create_page_in_space` resolves it. */
async function pageTitled(page: Page, title: string): Promise<string | null> {
  const resolved = await ipc<{ page_id: string | null }>(page, 'resolve_page_title', {
    title,
    scope: SCOPE,
  })
  return resolved.page_id
}

async function openTag(page: Page, name: string): Promise<Locator> {
  await navigateToView(page, 'Tags')
  await page.getByTestId(`tag-item-${name}`).click()
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(name)
  return page.getByTestId('tag-notes')
}

/** Start the notes of the open tag and write `text` as their first block. */
async function writeFirstNote(page: Page, notes: Locator, text: string): Promise<void> {
  await notes.getByRole('button', { name: 'Add notes', exact: true }).click()
  const editor = notes.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor).toBeFocused()
  await page.keyboard.insertText(text)
  await expect(editor).toHaveText(text)
  await blurEditors(page)
  await expect(notes.locator('[data-testid="block-static"]')).toHaveText([text])
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test.describe("A tag's page is written on @pages @editor", () => {
  test('notes added on a tag are the blocks of its page, kept and linked back', async ({
    page,
  }) => {
    let notes = await openTag(page, 'work')
    expect(await pageTitled(page, 'Tag/work')).toBeNull()

    await writeFirstNote(page, notes, 'Deep work rituals')

    await navigateToView(page, 'Pages')
    notes = await openTag(page, 'work')
    const row = notes.locator('[data-testid="sortable-block"]')
    await expect(row).toHaveText(['Deep work rituals'])
    await expect(notes.getByRole('button', { name: 'Add notes', exact: true })).toHaveCount(0)
    const pageId = await pageTitled(page, 'Tag/work')
    expect(pageId).not.toBeNull()
    const blockId = await row.getAttribute('data-block-id')
    expect(await ipc(page, 'get_block', { blockId })).toMatchObject({
      content: 'Deep work rituals',
      parent_id: pageId,
    })

    // The page, opened as a page, holds the same block and names its tag.
    // The Pages view lists it under its `Tag` namespace.
    await navigateToView(page, 'Pages')
    await page.locator('[data-page-title="Tag/work"]').click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Tag/work')
    await expect(
      page.locator(`[data-testid="sortable-block"][data-block-id="${blockId}"]`),
    ).toHaveText('Deep work rituals')
    await page.getByRole('button', { name: 'Notes of the tag #work', exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('work')
    await expect(page.getByTestId('tag-notes')).toContainText('Deep work rituals')
  })

  // "Notes" was a bold black heading over grey "Pages" and "Blocks", and its
  // "Add notes" a bordered button beside the line the empty panels centre (#7040).
  test("a tag's page titles its sections alike, and an empty one offers its action in place", async ({
    page,
  }) => {
    const notes = await openTag(page, 'idea')
    const empty = notes.getByRole('region', { name: 'Nothing is written on this tag yet.' })
    await expect(empty.getByRole('button', { name: 'Add notes', exact: true })).toBeVisible()

    const style = (el: Element) => {
      const css = getComputedStyle(el)
      return `${css.color} ${css.fontWeight} ${css.fontSize}`
    }
    const heading = (name: string) => page.getByRole('heading', { name, exact: true, level: 2 })
    const notesStyle = await heading('Notes').evaluate(style)
    expect(await heading('Pages').evaluate(style)).toBe(notesStyle)
    expect(await heading('Blocks').evaluate(style)).toBe(notesStyle)
  })

  test('renaming the tag moves its page, notes and all', async ({ page }) => {
    const notes = await openTag(page, 'idea')
    await writeFirstNote(page, notes, 'Seeds')
    const pageId = await pageTitled(page, 'Tag/idea')
    expect(pageId).not.toBeNull()

    await navigateToView(page, 'Tags')
    const row = page
      .locator('[data-slot="list-item"]')
      .filter({ has: page.getByTestId('tag-item-idea') })
    await row.hover()
    await row.getByRole('button', { name: 'Rename tag' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('New tag name').fill('insight')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('tag-item-insight')).toBeVisible()

    expect(await pageTitled(page, 'Tag/insight')).toBe(pageId)
    expect(await pageTitled(page, 'Tag/idea')).toBeNull()
    const moved = await openTag(page, 'insight')
    await expect(moved.locator('[data-testid="block-static"]')).toHaveText(['Seeds'])
  })

  test('renaming the page renames its tag, and one revert in History puts both back', async ({
    page,
  }) => {
    const notes = await openTag(page, 'idea')
    await writeFirstNote(page, notes, 'Seeds')
    const pageId = await pageTitled(page, 'Tag/idea')

    await navigateToView(page, 'Pages')
    await page.locator('[data-page-title="Tag/idea"]').click()
    const title = page.locator('[aria-label="Page title"]')
    await expect(title).toHaveText('Tag/idea')
    await title.click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText('Tag/insight')
    await page.keyboard.press('Tab')
    await expect(
      page.getByRole('button', { name: 'Notes of the tag #insight', exact: true }),
    ).toBeVisible()

    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-insight')).toBeVisible()
    await expect(page.getByTestId('tag-item-idea')).toHaveCount(0)
    expect(await pageTitled(page, 'Tag/insight')).toBe(pageId)

    // The newest op is the tag's half of the rename; reverting it alone
    // reverts the page's half too.
    await navigateToView(page, 'History')
    await page.locator('[data-history-item]').first().getByRole('checkbox').click()
    await page.getByRole('button', { name: /Revert selected/i }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Revert', exact: true }).click()
    await expect.poll(() => pageTitled(page, 'Tag/idea')).toBe(pageId)
    const back = await openTag(page, 'idea')
    await expect(back.locator('[data-testid="block-static"]')).toHaveText(['Seeds'])
  })

  test('a typed [[Tag/x]] makes the tag and links its page, as #x makes the tag', async ({
    page,
  }) => {
    const block = '0000000000000000000B10CK01'
    await openPage(page, 'Getting Started')
    const editor = await focusBlockById(page, block)
    await editor.press('End')
    await page.keyboard.type(' see [[Tag/typed-link]]', { delay: 30 })
    await expect(editor.locator('[data-testid="block-link-chip"]')).toHaveCount(1)
    await saveBlock(page)

    await expect.poll(() => pageTitled(page, 'Tag/typed-link')).not.toBeNull()
    const pageId = await pageTitled(page, 'Tag/typed-link')
    const stored = () => ipc<{ content: string }>(page, 'get_block', { blockId: block })
    await expect.poll(async () => (await stored()).content).toContain(`see [[${pageId}]]`)

    await openTag(page, 'typed-link')
    const tags = await ipc<{ tag_id: string; name: string }[]>(page, 'list_all_tags_in_space', {
      scope: SCOPE,
    })
    const tag = tags.find((row) => row.name === 'typed-link')
    expect(
      await ipc<{ id: string }>(page, 'create_tag_page', { tagId: tag?.tag_id }),
    ).toMatchObject({ id: pageId })

    await navigateToView(page, 'Pages')
    await page.locator('[data-page-title="Getting Started"]').click()
    const chip = page.locator(`[data-testid="block-link-chip"][data-id="${pageId}"]`)
    await chip.dispatchEvent('click')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Tag/typed-link')
    await page.getByRole('button', { name: 'Notes of the tag #typed-link', exact: true }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('typed-link')
  })

  test('a page under Tag/ is not made as an ordinary page', async ({ page }) => {
    await navigateToView(page, 'Pages')
    await page
      .locator('.page-browser-header')
      .getByRole('button', { name: 'New page', exact: true })
      .click()
    const dialog = page.getByTestId('new-page-dialog')
    const input = dialog.getByRole('textbox', { name: 'New page title' })
    await expect(input).toBeFocused()
    await input.fill('Tag/foo')
    await input.press('Enter')

    await expect(dialog.getByRole('alert')).toHaveText(
      'Pages under "Tag/" belong to their tags. Create or rename the tag instead.',
    )
    await expect(input).toHaveValue('Tag/foo')
    expect(await pageTitled(page, 'Tag/foo')).toBeNull()
  })
})
