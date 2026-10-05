import { expect, test, waitForBoot } from './helpers'

/**
 * #5260 — the Today keyboard shortcut (Alt+T by default) must land where the
 * header Today button does. Stream and agenda have no day to scroll to, so
 * both land on today's daily page; the shortcut used to only set the date and
 * left the user in the same view.
 */

const DATE_DISPLAY = '[data-testid="date-display"]'

for (const view of [
  { tab: 'Continuous stream view', panel: '[data-testid="journal-stream"]' },
  { tab: 'Agenda view', panel: '#journal-panel-agenda' },
]) {
  test(`Alt+T in ${view.tab} lands on today's daily page`, async ({ page }) => {
    await waitForBoot(page)
    const dateDisplay = page.locator(DATE_DISPLAY)
    await expect(dateDisplay).toBeVisible()
    const todayText = (await dateDisplay.textContent()) ?? ''

    // Move the daily date off today, so landing back on it proves the jump.
    await page.getByRole('button', { name: 'Previous day' }).click()
    await expect(dateDisplay).not.toHaveText(todayText)

    await page.getByRole('tab', { name: view.tab }).click()
    await expect(page.locator(view.panel)).toBeVisible()

    // Keep focus out of any editor: the shortcut skips while typing in a field.
    await page.locator('header').first().click()

    await page.keyboard.down('Alt')
    await page.keyboard.press('t')
    await page.keyboard.up('Alt')

    await expect(page.getByRole('tab', { name: 'Daily view' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator(view.panel)).toBeHidden()
    await expect(dateDisplay).toHaveText(todayText)
  })
}
