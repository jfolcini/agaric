import type { Locator, Page } from '@playwright/test'

import { activePopover, expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * The Templates view lists every template page with its first block as a
 * preview and a scope badge: "Journal template" for the journal template,
 * "Page template" otherwise. The page is marked through its kebab menu, and
 * the view re-reads both properties from the backend when it opens, so the
 * mock can show either one going missing.
 *
 * Seed data (tauri-mock): "Getting Started" opens with GS_1 (below);
 * "Meeting Notes Template" is a page template whose first block is
 * "## Attendees".
 */

const GS_FIRST_BLOCK = 'Welcome to Agaric! This is your personal knowledge base.'

function templateRow(page: Page, name: string): Locator {
  return page
    .locator('[data-slot="list-item"]')
    .filter({ has: page.getByRole('button', { name: `Open template ${name}`, exact: true }) })
}

async function pickPageAction(page: Page, action: string) {
  await page.getByRole('button', { name: 'Page actions' }).click()
  await activePopover(page).getByText(action, { exact: true }).click()
  await expect(activePopover(page)).toHaveCount(0)
}

test('lists a journal template with its first block and the journal badge', async ({ page }) => {
  await waitForBoot(page)
  await openPage(page, 'Getting Started')
  await pickPageAction(page, 'Save as template')
  await expect(page.getByText('Saved as template')).toBeVisible()
  await pickPageAction(page, 'Set as journal template')

  await navigateToView(page, 'Templates')

  const journal = templateRow(page, 'Getting Started')
  await expect(journal.getByText(GS_FIRST_BLOCK, { exact: true })).toBeVisible()
  await expect(journal.getByText('Journal template', { exact: true })).toBeVisible()

  const meeting = templateRow(page, 'Meeting Notes Template')
  await expect(meeting.getByText('## Attendees', { exact: true })).toBeVisible()
  await expect(meeting.getByText('Page template', { exact: true })).toBeVisible()
})
