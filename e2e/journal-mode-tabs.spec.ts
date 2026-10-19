import { expect, test, waitForBoot } from './helpers'

/**
 * The journal's mode tabs from the keyboard (#5920): the arrow keys move focus
 * along the tabs without switching mode, so passing Agenda does not mount it,
 * and Enter or Space switches to the focused tab's view.
 */

test('the journal mode tabs switch view from the keyboard @journal', async ({ page }) => {
  await waitForBoot(page)
  const tabs = page.getByRole('tablist', { name: 'Journal view mode' })
  const day = tabs.getByRole('tab', { name: 'Daily view' })
  const stream = tabs.getByRole('tab', { name: 'Continuous stream view' })
  const agenda = tabs.getByRole('tab', { name: 'Agenda view' })
  await expect(day).toHaveAttribute('aria-selected', 'true')

  await day.focus()
  await page.keyboard.press('End')
  await expect(agenda).toBeFocused()
  await expect(agenda).toHaveAttribute('aria-selected', 'false')
  await expect(day).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('agenda-view')).toHaveCount(0)

  await page.keyboard.press('Enter')
  await expect(agenda).toHaveAttribute('aria-selected', 'true')
  await expect(day).toHaveAttribute('aria-selected', 'false')
  await expect(page.locator('#journal-panel-agenda').getByTestId('agenda-view')).toBeVisible()

  await page.keyboard.press('ArrowLeft')
  await expect(stream).toBeFocused()
  await page.keyboard.press('Space')
  await expect(stream).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#journal-panel-stream').getByTestId('journal-stream')).toBeVisible()
  await expect(page.getByTestId('agenda-view')).toHaveCount(0)
})
