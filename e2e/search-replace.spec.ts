/**
 * Replace across pages from the Search view (#6608). With the replace row
 * open, the results are the blocks a replace would change, each ticked. The
 * run is asked for first, writes every ticked block in one command and leaves
 * the rest (an unticked block, a link's label) as they were; the toast's Undo
 * puts a run back. Every check reads the backend, and the page after leaving
 * the Search view.
 */
import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  expect,
  ipc,
  navigateToView,
  openPage,
  openSearchView,
  submitSearch,
  test,
} from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }

async function seedPage(page: Page, title: string, contents: string[]): Promise<string> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  await ipc(page, 'create_blocks_batch', {
    specs: contents.map((content) => ({
      blockType: 'content',
      content: content.replace('$PAGE', pageId),
      parentId: pageId,
      position: null,
    })),
  })
  return pageId
}

/** The text of every block of the page, as the backend holds it. */
async function stored(page: Page, pageId: string): Promise<string[]> {
  const { blocks } = await ipc<{
    blocks: Array<{ parent_id: string; position: number; content: string | null }>
  }>(page, 'load_page_subtree', { rootBlockId: pageId, scope: SCOPE })
  return blocks
    .filter((b) => b.parent_id === pageId)
    .toSorted((a, b) => a.position - b.position)
    .map((b) => b.content ?? '')
}

/** Search `find` with the replace row open and `replacement` typed. */
async function previewReplace(page: Page, find: string, replacement: string) {
  await submitSearch(page, find)
  const toggle = page.getByRole('button', { name: 'Replace across pages (Ctrl+H)' })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.getByRole('textbox', { name: 'Replace with' }).fill(replacement)
}

async function confirmReplace(page: Page, label: string): Promise<void> {
  await page.getByRole('button', { name: label }).click()
  const dialog = activeAlertDialog(page)
  await expect(dialog).toContainText(`${label}?`)
  await dialog.getByRole('button', { name: 'Replace', exact: true }).click()
}

test.describe('Replace across pages from Search @search @pages @editor', () => {
  test('replaces the ticked blocks on two pages, and Undo puts a run back', async ({ page }) => {
    await openSearchView(page)
    const alpha = await seedPage(page, 'Replace Alpha', ['first needle', 'second needle'])
    const beta = await seedPage(page, 'Replace Beta', [
      'third **nee**dle',
      'see [[$PAGE|needle link]]',
    ])

    await previewReplace(page, 'needle', 'zorbex')
    const rows = page.getByRole('option')
    await expect(rows).toHaveCount(3)
    await expect(
      page.getByRole('button', { name: 'Replace in 3 blocks across 2 pages' }),
    ).toBeEnabled()
    await expect(page.getByTestId('search-replace-status')).toHaveText(
      '1 match is in a link, tag or block reference and will be left as it is',
    )
    // The preview shows the change, and nothing is written yet.
    await expect(rows.filter({ hasText: 'first' })).toContainText('first needlezorbex')
    expect(await stored(page, alpha)).toEqual(['first needle', 'second needle'])

    // A click unticks a row.
    await rows.filter({ hasText: 'second' }).click()
    await expect(rows.filter({ hasText: 'second' })).toHaveAttribute('aria-selected', 'false')

    await confirmReplace(page, 'Replace in 2 blocks across 2 pages')
    const toast = page.locator('[data-sonner-toast][data-front="true"]')
    await expect(toast).toContainText('Replaced in 2 blocks across 2 pages')
    await expect.poll(() => stored(page, alpha)).toEqual(['first zorbex', 'second needle'])
    expect(await stored(page, beta)).toEqual(['third **zorbex**', `see [[${beta}|needle link]]`])
    // The search ran again: the unticked block is the one still to replace.
    await expect(rows).toHaveCount(1)

    // The pages show the new text after leaving the Search view.
    await openPage(page, 'Replace Alpha')
    await expect(page.getByText('first zorbex', { exact: true })).toBeVisible()
    await expect(page.getByText('second needle', { exact: true })).toBeVisible()

    // A second run, taken back by its toast.
    await navigateToView(page, 'Search')
    expect(await stored(page, alpha)).toEqual(['first zorbex', 'second needle'])
    await previewReplace(page, 'zorbex', 'quivex')
    await expect(rows).toHaveCount(2)
    await confirmReplace(page, 'Replace in 2 blocks across 2 pages')
    await expect.poll(() => stored(page, alpha)).toEqual(['first quivex', 'second needle'])
    await expect(toast).toContainText('Replaced in 2 blocks across 2 pages')
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => stored(page, alpha)).toEqual(['first zorbex', 'second needle'])
    expect(await stored(page, beta)).toEqual(['third **zorbex**', `see [[${beta}|needle link]]`])
    await expect(rows).toHaveCount(2)

    await openPage(page, 'Replace Beta')
    await expect(page.getByText('third zorbex', { exact: true })).toBeVisible()
  })

  test('the keyboard reaches the preview: Ctrl+H, Space on a row, the page checkbox', async ({
    page,
  }) => {
    await openSearchView(page)
    const alpha = await seedPage(page, 'Replace Keys', ['first needle', 'second needle'])
    await submitSearch(page, 'needle')
    await expect(page.getByRole('option')).toHaveCount(2)

    await page.keyboard.press('Control+h')
    const run = page.getByTestId('search-replace-run')
    await expect(run).toHaveText('Replace in 2 blocks across 1 page')

    const listbox = page.getByTestId(`search-result-group-${alpha}`)
    await listbox.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await expect(run).toHaveText('Replace in 1 block across 1 page')
    await expect(page.getByRole('option', { selected: true })).toHaveCount(1)

    const pageBox = page.getByRole('checkbox', { name: 'Replace in Replace Keys' })
    await pageBox.focus()
    await page.keyboard.press('Space')
    await expect(run).toHaveText('Replace in 2 blocks across 1 page')

    await page.keyboard.press('Control+h')
    await expect(page.getByTestId('search-replace-bar')).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Search blocks' })).toBeFocused()
    expect(await stored(page, alpha)).toEqual(['first needle', 'second needle'])
  })
})
