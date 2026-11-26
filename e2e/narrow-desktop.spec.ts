/**
 * E2E — a desktop in a narrow 1024 px window, sidebar expanded (#7040 C2).
 *
 * At this width Settings' content column is 200 px narrower than on a wider
 * window, so a row laid out for the wide column must wrap rather than squeeze.
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
    const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
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
