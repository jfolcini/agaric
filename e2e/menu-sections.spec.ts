/**
 * The page ⋮ menu's sections (#7040 O6, decision 21): separators group its rows
 * into Add, View, Template and Edit; copy link, Markdown, save file and print
 * sit in an Export submenu, which opens in place on a desktop and drills in on
 * a phone's menu sheet; Delete sits alone at the bottom. And the block menu,
 * as a Radix menu does, puts its first row's focus ring up only when the
 * keyboard opened it.
 */

import { devices, type Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeMenu,
  activeSheet,
  expect,
  openPage,
  openPageMobile,
  readClipboard,
  test,
  waitForBoot,
} from './helpers'

const PAGE = 'Getting Started'
const SECTIONS = ['Add', 'View', 'Template', 'Edit']
const pageMenu = (page: Page) => page.getByRole('menu', { name: 'Page actions', exact: true })

async function expectSectionsAndDeleteLast(page: Page): Promise<void> {
  const menu = pageMenu(page)
  await expect(menu.getByRole('group')).toHaveCount(SECTIONS.length)
  for (const [i, name] of SECTIONS.entries()) {
    await expect(menu.getByRole('group').nth(i)).toHaveAccessibleName(name)
  }
  await expect(menu.getByRole('menuitem').last()).toHaveAccessibleName('Delete page')
}

test.describe('Page ⋮ menu sections on a desktop @pages @markdown', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('opens Export in place, and its Markdown row copies the page', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await expectSectionsAndDeleteLast(page)
    const menu = pageMenu(page)
    await expect(menu.getByRole('menuitem', { name: /^Export as Markdown/ })).toHaveCount(0)

    await menu.getByRole('menuitem', { name: 'Export', exact: true }).click()
    const submenu = menu.getByRole('group', { name: 'Export', exact: true })
    await expect(submenu.getByRole('menuitem')).toHaveText([
      'Copy app link',
      /^Export as Markdown/,
      'Save as Markdown file',
      'Print…',
    ])
    await submenu.getByRole('menuitem', { name: /^Export as Markdown/ }).click()
    await expect(page.getByText('Markdown copied to clipboard', { exact: true })).toBeVisible()
    expect(await readClipboard(page)).toContain(`# ${PAGE}`)
  })
})

test.describe('Page ⋮ menu sections on a phone @pages @mobile', () => {
  const phone = devices['Pixel 7']
  test.use({
    viewport: { width: 412, height: 915 },
    userAgent: phone.userAgent,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: phone.deviceScaleFactor,
  })

  test('drills into Export inside the sheet, and its copy-link row copies the link', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)
    await page.getByRole('button', { name: 'Page actions', exact: true }).tap()
    await expect(activeSheet(page)).toBeVisible()
    await expectSectionsAndDeleteLast(page)
    const menu = pageMenu(page)

    await menu.getByRole('menuitem', { name: 'Export', exact: true }).tap()
    await expect(menu.getByRole('menuitem', { name: 'Add alias' })).toHaveCount(0)
    const submenu = menu.getByRole('group', { name: 'Export', exact: true })
    await expect(submenu.getByRole('menuitem', { name: 'Copy app link' })).toBeVisible()

    await menu.getByRole('menuitem', { name: 'Back', exact: true }).tap()
    await expect(menu.getByRole('menuitem', { name: 'Add alias' })).toBeVisible()
    await menu.getByRole('menuitem', { name: 'Export', exact: true }).tap()
    await submenu.getByRole('menuitem', { name: 'Copy app link' }).tap()
    await expect(page.getByText('App link copied to clipboard', { exact: true })).toBeVisible()
    expect(await readClipboard(page)).toBe(`agaric://page/${SEED_IDS.PAGE_GETTING_STARTED}`)
  })
})

/** Whether the menu's first row has focus, matches `:focus-visible`, and paints a ring. */
const firstRow = (page: Page) =>
  activeMenu(page)
    .getByRole('menuitem')
    .first()
    .evaluate((el) => ({
      focused: el === document.activeElement,
      ring: el.matches(':focus-visible') && getComputedStyle(el).boxShadow.includes('3px'),
    }))

test.describe('Block menu opening focus @editor', () => {
  test('a right click after typing opens the menu without a ring on its first row', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    // A key press leaves the browser in keyboard modality, which a right click
    // on text does not reset: a focused first row would draw its ring.
    await page.keyboard.press('Escape')
    await page
      .locator('[data-testid="block-static"]')
      .nth(1)
      .click({ button: 'right', position: { x: 8, y: 8 } })
    await expect(activeMenu(page)).toBeFocused()
    expect(await firstRow(page)).toEqual({ focused: false, ring: false })
    await expect(activeMenu(page)).toHaveCSS('outline-style', 'none')

    await page.keyboard.press('ArrowDown')
    await expect(activeMenu(page).getByRole('menuitem').first()).toBeFocused()
  })

  test('Shift+F10 opens it with its first row focused and ringed', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    await page
      .getByRole('radiogroup', { name: 'Editing mode' })
      .getByRole('radio', { name: 'Page' })
      .click()
    await page.locator('[data-testid="page-mode-editor"] .page-block-content').nth(1).click()
    await page.keyboard.press('Shift+F10')
    await expect(activeMenu(page).getByRole('menuitem').first()).toBeFocused()
    expect(await firstRow(page)).toEqual({ focused: true, ring: true })
  })
})
