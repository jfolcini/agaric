import { devices, type Locator, type Page } from '@playwright/test'

import { activePopover, expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * The Templates view lists every template page with its first block as a
 * preview and a scope badge: "Journal template" for the journal template,
 * "Page template" otherwise. The page is marked through its kebab menu, and
 * the view re-reads both properties from the backend when it opens, so the
 * mock can show either one going missing.
 *
 * Seed data (tauri-mock): "Getting Started" opens with `BLOCK_GS_1` (below);
 * "Meeting Notes Template" is a page template whose first block is
 * "## Attendees", which the preview shows rendered, without its Markdown.
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

test('lists a journal template with its first block and the journal badge @editor @pages', async ({
  page,
}) => {
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
  await expect(meeting.getByText('Attendees', { exact: true })).toBeVisible()
  await expect(meeting).not.toContainText('##')
  await expect(meeting.getByText('Page template', { exact: true })).toBeVisible()
})

// The Create button sat under the input at full width on a phone (#7040).
test.describe('Templates view on a phone @pages @mobile', () => {
  const pixel = devices['Pixel 7']
  test.use({
    viewport: { width: 412, height: 915 },
    hasTouch: true,
    isMobile: true,
    userAgent: pixel.userAgent,
  })

  test('the Create template button sits on the name input row', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Templates')
    const input = page.getByPlaceholder('New template name...')
    const create = page.getByRole('button', { name: 'Create template' })
    await expect(create).toBeDisabled()
    await input.fill('Standup')
    await expect(create).toBeEnabled()
    const [inputBox, createBox] = await Promise.all([input.boundingBox(), create.boundingBox()])
    if (!inputBox || !createBox) throw new Error('the create form is not laid out')
    expect(
      Math.abs(createBox.y + createBox.height / 2 - (inputBox.y + inputBox.height / 2)),
    ).toBeLessThanOrEqual(1)
    expect(createBox.x).toBeGreaterThanOrEqual(inputBox.x + inputBox.width)
  })
})
