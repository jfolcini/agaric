import type { Page } from '@playwright/test'

import {
  activeSuggestionList,
  blurEditors,
  expect,
  focusBlock,
  navigateToView,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E — surfaces that must refresh when a page title, an alias or a child
 * page changes while they hold an earlier read (#5249, #5250, #5253).
 */

/** Rename the open page through its header title and wait for the write. */
async function renameOpenPage(page: Page, title: string): Promise<void> {
  // `fill`, not Ctrl+A + type: with no block focused, Ctrl+A selects every
  // block instead of the title text, so the new title was appended to the old.
  const titleEl = page.locator('[aria-label="Page title"]')
  await titleEl.fill(title)
  await titleEl.press('Enter')
  await expect(page.locator('[data-sonner-toast]').getByText('Page renamed')).toBeVisible()
}

async function addBlock(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: /add block/i }).click()
  const editor = page.getByRole('textbox', { name: 'Block editor' })
  await expect(editor).toBeFocused()
  // ProseMirror writes its selection back 20 ms after the mount's focus, a frame late; a key typed
  // before then is lost.
  await editor.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20))),
  )
  await editor.pressSequentially(text, { delay: 30 })
  await expect(editor).toHaveText(text)
  await editor.press('Enter')
  await expect(page.getByText(text)).toBeVisible()
}

function graphNode(page: Page, label: string) {
  return page.getByTestId('graph-view').getByRole('option', { name: label, exact: true })
}

/** The unlinked-references panel, expanded. */
async function expandUnlinkedReferences(page: Page) {
  const unlinked = page.getByTestId('unlinked-references')
  await unlinked.getByRole('button', { name: /unlinked reference/i }).click()
  return unlinked
}

function linkFailedToast(page: Page) {
  return page.locator('[data-sonner-toast]').getByText('Failed to link reference')
}

test.describe('Rename and create invalidation @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the graph shows a renamed page under its new title, and opening it keeps that title (#5250)', async ({
    page,
  }) => {
    // The d3 worker start-up can outlast the default expect timeout (see graph-view.spec.ts).
    test.slow()
    // Visiting the graph first fills its module cache, which is what went stale.
    await navigateToView(page, 'Graph')
    await graphNode(page, 'Meetings').press('Enter')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Meetings')

    await renameOpenPage(page, 'Standups')

    await navigateToView(page, 'Graph')
    await expect(graphNode(page, 'Standups')).toHaveCount(1)
    await expect(graphNode(page, 'Meetings')).toHaveCount(0)

    await graphNode(page, 'Standups').press('Enter')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Standups')
  })

  test('after a rename, Unlinked References lists the new title and "Link it" succeeds (#5249)', async ({
    page,
  }) => {
    await openPage(page, 'Meetings')
    await addBlock(page, 'Getting Started has more onboarding tips.')
    await addBlock(page, 'The Onboarding Guide covers the first week.')

    await openPage(page, 'Getting Started')
    const unlinked = await expandUnlinkedReferences(page)
    const linkOldTitle = unlinked.getByRole('button', { name: /^Link it: Getting Started has/ })
    const linkNewTitle = unlinked.getByRole('button', { name: /^Link it: The Onboarding Guide/ })
    await expect(linkOldTitle).toBeVisible()
    await expect(linkNewTitle).toHaveCount(0)

    await renameOpenPage(page, 'Onboarding Guide')

    await expect(linkNewTitle).toBeVisible()
    await expect(linkOldTitle).toHaveCount(0)
    await linkNewTitle.click()
    await expect(linkNewTitle).toHaveCount(0)
    await expect(linkFailedToast(page)).toHaveCount(0)
  })

  test('after adding an alias, "Link it" on an alias-only mention succeeds (#5249)', async ({
    page,
  }) => {
    await openPage(page, 'Meetings')
    await addBlock(page, 'Getting Started has more onboarding tips.')
    await addBlock(page, 'Kickoff agenda is ready for review.')

    await openPage(page, 'Getting Started')
    const unlinked = await expandUnlinkedReferences(page)
    await expect(
      unlinked.getByRole('button', { name: /^Link it: Getting Started has/ }),
    ).toBeVisible()
    const linkAlias = unlinked.getByRole('button', { name: /^Link it: Kickoff agenda/ })
    await expect(linkAlias).toHaveCount(0)

    await page
      .getByText('Also known as:', { exact: true })
      .locator('..')
      .getByRole('button', { name: 'Edit', exact: true })
      .click()
    const aliasInput = page.getByRole('textbox', { name: 'New alias input' })
    await aliasInput.fill('Kickoff')
    await aliasInput.press('Enter')
    await expect(aliasInput).toHaveValue('')

    await expect(linkAlias).toBeVisible()
    await linkAlias.click()
    await expect(linkAlias).toHaveCount(0)
    await expect(linkFailedToast(page)).toHaveCount(0)
  })

  test('the Pages filter and the [[ picker find a renamed page by its new title only (#5365)', async ({
    page,
  }) => {
    // Both read a copy the materializer keeps (the pages list, FTS past two characters), not the
    // block, so only the bridge shows a copy the rename missed. No word is shared between titles.
    await openPage(page, 'Meetings')
    await renameOpenPage(page, 'Velvet lantern')

    await navigateToView(page, 'Tags')
    await navigateToView(page, 'Pages')
    const titles = page.getByRole('grid').locator('.page-browser-item-title')
    await expect(titles.filter({ hasText: /^Velvet lantern$/ })).toHaveCount(1)
    await expect(titles.filter({ hasText: /^Meetings$/ })).toHaveCount(0)
    const filter = page
      .locator('.page-browser-header')
      .getByRole('textbox', { name: 'Search pages...' })
    await filter.fill('Velvet lantern')
    await expect(titles).toHaveText(['Velvet lantern'])
    await filter.fill('Meetings')
    await expect(titles).toHaveCount(0)
    await filter.fill('')

    await openPage(page, 'Getting Started')
    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[Velvet lan', { delay: 20 })
    const items = activeSuggestionList(page).locator('[data-testid="suggestion-item"]')
    const existing = items.and(page.locator(':not(#suggestion-__create__)'))
    await expect(existing.filter({ hasText: 'Velvet lantern' })).toHaveCount(1)
    await page.keyboard.press('Escape')
    await page.keyboard.type(' [[Meetings', { delay: 20 })
    // The create item names the query, so once it reads the whole old title the items answer it.
    await expect(page.locator('#suggestion-__create__')).toContainText('Meetings')
    await expect(existing).toHaveCount(0)
  })

  test('a [[Parent/Child]] page created from the picker appears in the parent Pages section (#5253)', async ({
    page,
  }) => {
    await openPage(page, 'Projects')
    const section = page.getByTestId('pages-tree-section')
    await expect(section).toHaveCount(0)

    await focusBlock(page)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[Projects/Alpha', { delay: 20 })
    const createItem = activeSuggestionList(page).locator('[data-testid="suggestion-item"]', {
      hasText: /[Cc]reate/,
    })
    await createItem.click()
    await expect(
      page.locator('[data-testid="block-editor"] [data-testid="block-link-chip"]'),
    ).toBeVisible()
    // Committing the edit that carries the new link is what bumps the panel.
    await blurEditors(page)

    await expect(section).toBeVisible()
    await section.getByRole('button', { name: /pages tree/i }).click()
    await expect(section.getByText('Alpha', { exact: true })).toBeVisible()
  })
})
