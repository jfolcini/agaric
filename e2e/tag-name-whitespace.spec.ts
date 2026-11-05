import type { Page } from '@playwright/test'

import {
  activeDialog,
  activePopover,
  clearConsoleErrors,
  expect,
  getConsoleErrors,
  ipc,
  navigateToView,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6278 I4: a new tag name holds no whitespace, which Obsidian's `#tag` cannot
 * spell. Creating or renaming a tag to one in the Tags view is refused with a
 * toast that says to use `-`, and nothing is written: re-read from the mock
 * backend after navigating away and back. A picker's Create row offers the
 * dashed name instead, and creates it.
 */

const MESSAGE = "A tag name can't contain spaces. Use - instead, as in deep-work."

async function tagNames(page: Page): Promise<string[]> {
  const rows = await ipc<Array<{ name: string }>>(page, 'list_all_tags_in_space', {
    scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
  })
  return rows.map((row) => row.name).toSorted()
}

function toast(page: Page) {
  return page.locator('[data-sonner-toast]').getByText(MESSAGE, { exact: true })
}

async function reopenTags(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await navigateToView(page, 'Tags')
}

test.describe('A tag name holds no whitespace (#6278 I4) @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Tags')
  })

  test('creating `deep work` says to use a dash and makes no tag', async ({ page }) => {
    await page.getByPlaceholder('New tag name...').fill('deep work')
    await page.getByRole('button', { name: 'Add Tag' }).click()

    await expect(toast(page)).toBeVisible()
    // The Tags view logs a refused create as an error.
    expect(getConsoleErrors(page)).toEqual([
      expect.stringContaining("the tag name 'deep work' holds whitespace"),
    ])
    clearConsoleErrors(page)
    await reopenTags(page)
    await expect(page.getByTestId('tag-item-work')).toBeVisible()
    expect(await tagNames(page)).toEqual(['idea', 'personal', 'work'])
  })

  test('renaming to `deep work` says to use a dash and keeps the name', async ({ page }) => {
    const row = page
      .locator('[data-slot="list-item"]')
      .filter({ has: page.getByTestId('tag-item-idea') })
    await row.hover()
    await row.getByRole('button', { name: 'Rename tag' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('New tag name').fill('deep work')
    await dialog.getByRole('button', { name: 'Save' }).click()

    await expect(toast(page)).toBeVisible()
    await reopenTags(page)
    await expect(page.getByTestId('tag-item-idea')).toBeVisible()
    expect(await tagNames(page)).toEqual(['idea', 'personal', 'work'])
  })
})

test.describe('A picker names the tag it creates (#6278 I4) @pages', () => {
  test('the page header offers `deep-work` for `deep work`, creating and applying it', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Add tag', exact: true }).click()
    await activePopover(page).getByLabel('Search tags').fill('deep work')
    await activePopover(page).getByRole('button', { name: 'Create "deep-work"' }).click()

    await expect(
      page.getByRole('button', { name: 'Remove tag deep-work', exact: true }),
    ).toBeVisible()
    await navigateToView(page, 'Tags')
    await expect(page.getByTestId('tag-item-deep-work')).toBeVisible()
    expect(await tagNames(page)).toEqual(['deep-work', 'idea', 'personal', 'work'])
  })
})
