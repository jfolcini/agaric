/**
 * E2E — a desktop in a narrow 1024 px window, sidebar expanded (#7040 C2).
 *
 * At this width the content column is 200 px narrower than on a wider window,
 * so a row laid out for the wide column must wrap or shed a word rather than
 * squeeze.
 */

import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

test.use({ viewport: { width: 1024, height: 768 } })

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
})

test('Settings › Properties keeps the new property name readable @settings', async ({ page }) => {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
  const name = page.getByRole('textbox', { name: 'Property key', exact: true })
  await name.fill('Estimate')

  // The text box has room for its placeholder, so a typed name shows whole.
  const room = await name.evaluate((el: HTMLInputElement) => {
    const style = getComputedStyle(el)
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx === null) throw new Error('no 2d canvas')
    ctx.font = style.font
    // From the border box: Chromium's clientWidth of an input already leaves out the padding.
    const inner =
      el.getBoundingClientRect().width -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight) -
      parseFloat(style.borderLeftWidth) -
      parseFloat(style.borderRightWidth)
    return { inner, needed: ctx.measureText(el.placeholder).width }
  })
  expect(room.inner).toBeGreaterThanOrEqual(room.needed)
})

test('Settings › Properties keeps the select options box usable @settings', async ({ page }) => {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
  await page.getByRole('combobox', { name: 'Type', exact: true }).click()
  await page.getByRole('option', { name: 'select', exact: true }).click()

  const box = await page.getByRole('textbox', { name: 'Options, comma-separated' }).boundingBox()
  // 12rem, the floor the row wraps at.
  expect(box?.width).toBeGreaterThanOrEqual(192)
})

test("Journal › Week's date chip shows its whole text beside an icon-only Search @journal", async ({
  page,
}) => {
  await page.getByRole('tab', { name: 'Weekly view' }).click()

  // The top bar's Search drops its word below 1280 px; the name stays.
  await expect(page.getByTestId('header-search-button')).toHaveAccessibleName('Search')

  const date = page.getByTestId('date-display')
  await expect(date).toBeVisible()
  const fit = await date.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
  expect(fit.scroll).toBeLessThanOrEqual(fit.client)
})
