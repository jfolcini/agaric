import type { Locator, Page } from '@playwright/test'

import {
  activeSuggestionList,
  expect,
  focusBlockById,
  openPage,
  reopenPage,
  saveBlock,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

/**
 * E2E — picker happy paths (#5734): `[[` finding a page by its alias, and the
 * `/link`, `/tag` and `/block-ref` commands opening the picker they name. Each
 * test saves the block, reopens the page and reads the static render, so what
 * it asserts is the stored block. These live in `e2e/` because the mock models
 * every call the flows make (aliases, page, tag and block search, the block
 * edit), so it can show each failing.
 */

// `SEED_IDS.BLOCK_GS_1` in src/lib/tauri-mock/seed.ts, the first block of
// "Getting Started", which holds no chip.
const GS_1 = '0000000000000000000BLOCK01'

const GETTING_STARTED = 'Getting Started'

function staticBlock(page: Page, id: string): Locator {
  return page.locator(`[data-testid="block-static"][data-block-id="${id}"]`)
}

async function runSlashCommand(page: Page, query: string, label: string): Promise<void> {
  const menu = await typeSlashCommand(page, query)
  await menu.getByRole('option', { name: label, exact: true }).click()
}

async function pickerNamed(page: Page, name: string): Promise<Locator> {
  const list = activeSuggestionList(page)
  await expect(list).toHaveAttribute('aria-label', name)
  return list
}

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('[[ offers a page by an alias its title lacks, and links the page', async ({ page }) => {
  // Not the seeded `proj`: "Projects" matches that by title, so its alias row
  // is dropped as a duplicate. An alias no title holds is found only by alias.
  await openPage(page, 'Meetings')
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Add alias', exact: true }).click()
  const aliasInput = page.getByRole('textbox', { name: 'New alias input', exact: true })
  await aliasInput.fill('huddle')
  await aliasInput.press('Enter')
  await expect(aliasInput).toHaveValue('')

  await openPage(page, GETTING_STARTED)
  const editor = await focusBlockById(page, GS_1)
  await page.keyboard.press('End')
  await page.keyboard.type(' [[huddle', { delay: 30 })
  const byAlias = activeSuggestionList(page).getByRole('option', {
    name: 'Meetings (alias: huddle)',
    exact: true,
  })
  await expect(byAlias).toBeVisible()
  await byAlias.click()
  await expect(editor.getByTestId('block-link-chip')).toHaveText('Meetings')
  await saveBlock(page, 'Escape')

  await reopenPage(page, GETTING_STARTED)
  await expect(staticBlock(page, GS_1).getByTestId('block-link-chip')).toHaveText('Meetings')
})

test.describe('slash reference commands open their picker', () => {
  test.beforeEach(async ({ page }) => {
    await openPage(page, GETTING_STARTED)
    await focusBlockById(page, GS_1)
  })

  test('/link inserts the picked page link, which persists', async ({ page }) => {
    await runSlashCommand(page, 'link', 'LINK — Insert page link')
    const picker = await pickerNamed(page, 'Block links')
    await picker.getByRole('option', { name: 'Projects', exact: true }).click()
    await saveBlock(page, 'Escape')

    await reopenPage(page, GETTING_STARTED)
    await expect(staticBlock(page, GS_1).getByTestId('block-link-chip')).toHaveText('Projects')
  })

  test('/tag inserts the picked tag, which persists', async ({ page }) => {
    await runSlashCommand(page, 'tag', 'TAG — Insert tag reference')
    const picker = await pickerNamed(page, 'Tags')
    await picker.getByRole('option', { name: 'idea', exact: true }).click()
    await saveBlock(page, 'Escape')

    await reopenPage(page, GETTING_STARTED)
    await expect(staticBlock(page, GS_1).getByTestId('tag-ref-chip')).toHaveText('idea')
  })

  test('/block-ref inserts the picked block reference, which persists', async ({ page }) => {
    await runSlashCommand(page, 'block-ref', 'BLOCK-REF — Insert block reference')
    await page.keyboard.type('design', { delay: 30 })
    const picker = await pickerNamed(page, 'Block references')
    await picker.getByRole('option', { name: /^Design review feedback/ }).click()
    await saveBlock(page, 'Escape')

    await reopenPage(page, GETTING_STARTED)
    await expect(staticBlock(page, GS_1).getByTestId('block-ref-chip')).toHaveText(
      'Design review feedback',
    )
  })
})
