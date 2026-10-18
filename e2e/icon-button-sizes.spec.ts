/**
 * Icons inside a Button render the size their own class asks for, and an
 * `icon-xs` button's unsized icon renders at 16 px. The Button's icon rule
 * used to outrank `h-*`/`w-*` on the icon and shrink `icon-xs` icons to a
 * blurry 12 px, so the classes said one size and the screen showed another.
 */

import type { Locator } from '@playwright/test'

import {
  createPageFromPagesView,
  expect,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

const iconSize = (button: Locator) =>
  button.locator('svg').evaluate((icon) => {
    const { width, height } = icon.getBoundingClientRect()
    return `${width}x${height}`
  })

const centreY = (element: Locator) =>
  element.evaluate((el) => {
    const { top, height } = el.getBoundingClientRect()
    return top + height / 2
  })

test('icon buttons across the app render their icons at the asked size @pages @settings', async ({
  page,
}) => {
  await waitForBoot(page)
  const back = page.getByRole('button', { name: 'Back', exact: true })
  await expect(back).toBeVisible()
  expect(await iconSize(back)).toBe('16x16')

  await navigateToView(page, 'Pages')
  await createPageFromPagesView(page, 'work/project-a')
  await navigateToView(page, 'Pages')
  const row = page.locator('[data-page-item]:has-text("Quick Notes")')
  expect(await iconSize(row.getByRole('button', { name: 'Bookmark page' }))).toBe('16x16')
  expect(await iconSize(row.getByRole('button', { name: 'Delete page' }))).toBe('16x16')
  // The row's checkbox and icons share one vertical centre.
  const centres = await Promise.all(
    ['[data-slot="checkbox"]', '.lucide-bookmark', '.lucide-file-text', '.lucide-trash-2'].map(
      (selector) => centreY(row.locator(selector)),
    ),
  )
  expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(0.5)
  const treeDelete = page.getByRole('button', { name: 'Delete work/project-a', exact: true })
  expect(await iconSize(treeDelete)).toBe('16x16')

  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Properties')
  const deleteContext = page.getByRole('button', { name: 'Delete property context' })
  await expect(deleteContext).toBeVisible()
  expect(await iconSize(deleteContext)).toBe('16x16')

  // A tag row's actions ask for 14 px, the size of the row's color swatch.
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Tags', exact: true })
    .click()
  const rename = page.getByRole('button', { name: 'Rename tag' }).first()
  await expect(rename).toBeAttached()
  expect(await iconSize(rename)).toBe('14x14')
})
