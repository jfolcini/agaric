/**
 * #6749 — a page lists what its blocks link to, under the page each target
 * lives on, and a row jumps to the linking block.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): GS_2, on "Getting Started", links to
 * "Quick Notes". The test gives GS_3 a link to "Projects".
 */

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeSuggestionList,
  expect,
  focusBlock,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

const SECTION = '[data-testid="outgoing-links"]'

test.describe('Outgoing links @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a page with two links lists both and jumps to the linking block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page, 2)
    await page.keyboard.press('End')
    await page.keyboard.type(' [[Projects', { delay: 30 })
    const suggestions = activeSuggestionList(page)
    await expect(suggestions.locator('[data-testid="suggestion-item"]').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await saveBlock(page, 'Escape')

    const section = page.locator(SECTION)
    await section.getByRole('button', { name: /Outgoing links/ }).click()
    const toQuickNotes = section.getByRole('list', { name: 'Links to Quick Notes' })
    const toProjects = section.getByRole('list', { name: 'Links to Projects' })
    await expect(toQuickNotes.getByRole('button')).toHaveCount(1)
    await expect(toQuickNotes).toContainText('Use the sidebar to navigate')
    await expect(toProjects.getByRole('button')).toHaveCount(1)

    await toProjects.getByRole('button').click()
    await expect(
      page.locator(`[data-block-id="${SEED_IDS.BLOCK_GS_3}"] [contenteditable="true"]`),
    ).toBeFocused()
  })
})
