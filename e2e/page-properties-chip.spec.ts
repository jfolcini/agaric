/**
 * #7155 R13 — a page's properties open from a "Properties N" chip at the end of
 * its tags row: a dialog on desktop, a bottom sheet on a phone. A page with none
 * shows no chip; its ⋮ › Properties… opens the same surface, which is how the
 * first one is added. The collapsible that used to sit under the tags is gone.
 */

import { devices, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activePopover,
  closePageProperties,
  expect,
  ipc,
  openPage,
  openPageMobile,
  openPageProperties,
  openPagePropertiesFromMenu,
  test,
  waitForBoot,
} from './helpers'

const PAGE = 'Quick Notes'

function chip(page: Page) {
  return page.getByRole('button', { name: /^Properties \d+$/ })
}

async function setReviewer(page: Page): Promise<void> {
  await ipc(page, 'set_property', {
    blockId: SEED_IDS.PAGE_QUICK_NOTES,
    key: 'reviewer',
    value: { value_text: 'Ana' },
  })
}

test.describe('page Properties chip on desktop @pages @editor', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('with none, no chip; ⋮ › Properties… opens a dialog where the first one is added, then the chip shows', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    // Quick Notes has no tags, so the row holding the chip shows only once it has a property.
    await expect(page.getByRole('button', { name: 'Add tag', exact: true })).toHaveCount(0)
    await expect(chip(page)).toHaveCount(0)

    const dialog = await openPagePropertiesFromMenu(page)
    await expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
    await dialog.getByRole('button', { name: 'Add property', exact: true }).click()
    await activePopover(page).getByRole('button', { name: 'Reviewer text', exact: true }).click()
    const reviewer = dialog.getByRole('textbox', { name: 'reviewer value', exact: true })
    await reviewer.fill('Ana')
    await reviewer.press('Enter')
    await closePageProperties(page)

    // The chip ends the tags row, after its Add tag button.
    const addTag = page.getByRole('button', { name: 'Add tag', exact: true })
    await expect(chip(page)).toHaveAccessibleName('Properties 1')
    const [tagBox, chipBox] = await Promise.all([addTag.boundingBox(), chip(page).boundingBox()])
    expect(chipBox && tagBox && chipBox.x > tagBox.x).toBe(true)
    expect(chipBox && tagBox && Math.abs(chipBox.y - tagBox.y) < tagBox.height).toBe(true)
  })

  test('the chip opens the dialog with the page’s properties', async ({ page }) => {
    await waitForBoot(page)
    await setReviewer(page)
    await openPage(page, PAGE)

    const dialog = await openPageProperties(page)
    await expect(dialog).toHaveAttribute('data-slot', 'dialog-content')
    await expect(dialog.getByRole('textbox', { name: 'reviewer value', exact: true })).toHaveValue(
      'Ana',
    )
  })
})

const pixel = devices['Pixel 7']

test.describe('page Properties chip on a phone @pages @mobile', () => {
  test.use({
    viewport: pixel.viewport,
    userAgent: pixel.userAgent,
    hasTouch: true,
    isMobile: true,
  })

  test('the chip opens a bottom sheet with the page’s properties', async ({ page }) => {
    await waitForBoot(page)
    await setReviewer(page)
    await openPageMobile(page, PAGE)

    const sheet = await openPageProperties(page)
    await expect(sheet).toHaveAttribute('data-slot', 'sheet-content')
    const { width, height } = page.viewportSize() ?? { width: 0, height: 0 }
    await expect
      .poll(() =>
        sheet.evaluate((el) => {
          const r = el.getBoundingClientRect()
          return [Math.round(r.left), Math.round(r.right), Math.round(r.bottom)]
        }),
      )
      .toEqual([0, width, height])
    await expect(sheet.getByRole('textbox', { name: 'reviewer value', exact: true })).toHaveValue(
      'Ana',
    )
  })
})
