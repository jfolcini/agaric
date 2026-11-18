import type { Page } from '@playwright/test'

import {
  clearConsoleErrors,
  expect,
  focusBlock,
  getConsoleErrors,
  ipc,
  navigateToView,
  test,
  waitForBoot,
} from './helpers'

/**
 * The backend writes its refusals in English; a coded one reaches the user as
 * the sentence for its code, in the UI language. Driven through the mock's
 * `InvalidRepeatRule` refusal of an inline `repeat::` line.
 */

const REPEAT_RULE_HELP_ES =
  'Esa regla de repetición no es válida. Usa `daily`, `weekly`, `monthly`, `yearly`, o `+Nd` / `+Nw` / `+Nm` / `+Ny` con N de 1 o más, opcionalmente precedido de `.+` (contar desde que la completas) o `++` (ponerse al día hasta hoy).'

interface PropertyRow {
  key: string
}

async function switchToSpanish(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await page.getByRole('tab', { name: 'General', exact: true }).click()
  await page.getByRole('combobox', { name: 'Language' }).click()
  await page.getByRole('option', { name: 'Español', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Idioma' })).toBeVisible()
}

test('a refused repeat rule is explained in Spanish @editor @settings', async ({ page }) => {
  await waitForBoot(page)
  await switchToSpanish(page)
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Páginas', exact: true })
    .click()
  await page.getByText('Getting Started', { exact: true }).click()

  const first = await focusBlock(page, 0)
  await first.press('End')
  await first.press('Enter')
  const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
  await expect(editor.locator('p.is-editor-empty')).toBeVisible()
  const blockId = await page.locator('[data-testid="block-editor"]').getAttribute('data-block-id')
  await page.keyboard.type('repeat:: nope', { delay: 30 })
  await expect(editor).toContainText('repeat:: nope')
  // Leave it for the block above.
  await focusBlock(page, 0)

  await expect(
    page.locator('[data-sonner-toast]').getByText(REPEAT_RULE_HELP_ES, { exact: true }),
  ).toBeVisible()
  expect(await ipc<PropertyRow[]>(page, 'get_properties', { blockId })).toEqual([])
  // The refused line is logged as every refused inline property is.
  expect(getConsoleErrors(page)).toEqual([
    expect.stringContaining('Failed to set inline property from :: syntax'),
  ])
  clearConsoleErrors(page)
})
