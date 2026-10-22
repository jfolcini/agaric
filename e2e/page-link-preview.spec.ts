/**
 * #5691 — Ctrl (Cmd) + hover on a `[[page]]` chip previews that page, as
 * Obsidian's page preview does in its editor, in block mode and in page mode.
 *
 * Seed (`src/lib/tauri-mock/seed.ts`): the first block of "Quick Notes" links
 * to "Getting Started", whose first block reads "Welcome to Agaric! …". That
 * text is on the other page only, so a preview that merely echoed the chip
 * would fail.
 */

import { expect, openPage, test, waitForBoot } from './helpers'

const PEEK = '[data-testid="ref-peek"]'

test.describe('Page-link preview @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await waitForBoot(page)
    await openPage(page, 'Quick Notes')
  })

  test('Ctrl pressed over a page link in block mode previews the page', async ({ page }) => {
    const chip = page
      .locator('[data-testid="block-static"] [data-testid="block-link-chip"]')
      .filter({ hasText: 'Getting Started' })
    await chip.hover()
    await page.keyboard.down('Control')

    const peek = page.locator(PEEK)
    await expect(peek).toContainText('Welcome to Agaric!')
    await expect(peek).toHaveAccessibleName('Preview of Getting Started')
    await page.keyboard.up('Control')
  })

  // The pointer rests on a link while the writer types: Ctrl+← is a chord, not
  // a request to preview.
  test('a Ctrl shortcut typed with the pointer on a page link previews nothing', async ({
    page,
  }) => {
    const chip = page
      .locator('[data-testid="block-static"] [data-testid="block-link-chip"]')
      .filter({ hasText: 'Getting Started' })
    const peek = page.locator(PEEK)
    await chip.hover()

    await page.keyboard.press('Control+ArrowLeft')
    // Past the dwell, then two frames so a peek it scheduled would have rendered.
    await page.clock.runFor(1000)
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    )
    await expect(peek).toHaveCount(0)

    await page.keyboard.down('Control')
    await page.clock.runFor(1000)
    await expect(peek).toContainText('Welcome to Agaric!')
    await page.keyboard.up('Control')
  })

  test('a Ctrl+click on a previewed page link opens it in a new tab and closes the preview', async ({
    page,
  }) => {
    const chip = page
      .locator('[data-testid="block-static"] [data-testid="block-link-chip"]')
      .filter({ hasText: 'Getting Started' })
    const peek = page.locator(PEEK)
    const tabs = page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
    await chip.hover()
    await page.keyboard.down('Control')
    await expect(peek).toContainText('Welcome to Agaric!')

    await chip.click({ modifiers: ['Control'] })
    await page.keyboard.up('Control')

    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
    await expect(peek).toHaveCount(0)
  })

  test('Ctrl held while hovering a page link in page mode previews the page', async ({ page }) => {
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    const chip = page
      .locator('[data-testid="page-mode-editor"] [data-testid="block-link-chip"]')
      .filter({ hasText: 'Getting Started' })
    await expect(chip).toBeVisible()

    await page.keyboard.down('Control')
    await chip.hover()

    await expect(page.locator(PEEK)).toContainText('Welcome to Agaric!')
    await page.keyboard.up('Control')
  })
})
