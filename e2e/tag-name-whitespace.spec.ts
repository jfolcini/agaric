import type { Page } from '@playwright/test'

import {
  activeDialog,
  clearConsoleErrors,
  expect,
  getConsoleErrors,
  ipc,
  navigateToView,
  test,
  waitForBoot,
} from './helpers'

/**
 * #6278 I4: a new tag name holds no whitespace, which Obsidian's `#tag` cannot
 * spell. Creating or renaming a tag to one in the Tags view is refused with a
 * toast that says to use `-`, and nothing is written: re-read from the mock
 * backend after navigating away and back.
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
