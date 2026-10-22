import { devices, type Locator, type Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  focusBlockById,
  openPage,
  saveBlock,
  test,
  touchLongPress,
  waitForBoot,
} from './helpers'

/**
 * A middle click on something that opens a page, or "Open in new tab" in its
 * right-click menu, opens the page in a background tab: the tab strip gains
 * it and the current view stays on screen. A Ctrl/Cmd+click on a link does the
 * same, and Alt+Enter at a link follows it, in block mode and page mode.
 *
 * Seed data (tauri-mock): "Getting Started" holds a [[Quick Notes]] link.
 */

/** The seeded Getting Started block holding the [[Quick Notes]] link. */
const LINK_BLOCK = '0000000000000000000BLOCK02'
const PAGE_MODE_EDITOR = '[data-testid="page-mode-editor"]'

function tabs(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
}

async function openPagesView(page: Page) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  const row = page.locator('.page-browser-item', { hasText: 'Quick Notes' })
  await expect(row).toBeVisible()
  return row
}

async function expectStillOnPagesWithBackgroundTab(page: Page) {
  await expect(tabs(page)).toHaveCount(2)
  await expect(tabs(page).nth(1)).toHaveText(/Quick Notes/)
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'false')
  await expect(page.locator('[aria-label="Page title"]')).toHaveCount(0)
  await expect(page.locator('.page-browser-item').first()).toBeVisible()
}

async function expectStillOnGettingStartedWithBackgroundTab(page: Page) {
  await expect(tabs(page)).toHaveCount(2)
  await expect(tabs(page).nth(0)).toHaveText(/Getting Started/)
  await expect(tabs(page).nth(0)).toHaveAttribute('aria-selected', 'true')
  await expect(tabs(page).nth(1)).toHaveText(/Quick Notes/)
  await expect(tabs(page).nth(1)).toHaveAttribute('aria-selected', 'false')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
}

async function openInPageMode(page: Page) {
  await openPage(page, 'Getting Started')
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator(`${PAGE_MODE_EDITOR} [data-testid="block-link-chip"]`)).toBeVisible()
}

function inlineLink(page: Page): Locator {
  return page
    .getByTestId('block-tree')
    .locator('[data-testid="block-link-chip"]', { hasText: 'Quick Notes' })
}

/** "Getting Started" with a table-mode query block; returns its first page name. */
async function queryTablePageName(page: Page): Promise<Locator> {
  await openPage(page, 'Getting Started')
  await focusBlock(page)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('{{query tag:work table:true}}', { delay: 20 })
  await saveBlock(page)
  const pageName = page.locator('[data-testid="query-result"] table').getByRole('link').first()
  await expect(pageName).toBeVisible()
  return pageName
}

async function expectOnlyOpenInNewTabMenu(page: Page) {
  await expect(page.getByRole('menuitem', { name: 'Open in new tab' })).toBeVisible()
  // Counted by attribute: the open menu hides a second one from the accessibility tree.
  await expect(page.locator('[role="menu"]')).toHaveCount(1)
}

test.describe('Background tabs @pages @mobile', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('middle click on an inline link opens it behind the current page', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await expect(tabs(page)).toHaveCount(0)

    await inlineLink(page).click({ button: 'middle' })

    await expectStillOnGettingStartedWithBackgroundTab(page)
    // The static block was not turned into the editor.
    await expect(page.locator('[data-testid="block-editor"] [contenteditable="true"]')).toHaveCount(
      0,
    )
  })

  test('middle click on a Pages row opens it behind the Pages view', async ({ page }) => {
    const row = await openPagesView(page)

    await row.click({ button: 'middle' })

    await expectStillOnPagesWithBackgroundTab(page)
  })

  test('right click → "Open in new tab" on an inline link opens it behind the page', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')

    await inlineLink(page).click({ button: 'right' })
    const item = page.getByRole('menuitem', { name: 'Open in new tab' })
    await expect(item).toBeVisible()
    await item.click()

    await expectStillOnGettingStartedWithBackgroundTab(page)
  })

  test('right click → "Open in new tab" on a Pages row opens it behind the Pages view', async ({
    page,
  }) => {
    const row = await openPagesView(page)

    await row.click({ button: 'right' })
    const item = page.getByRole('menuitem', { name: 'Open in new tab' })
    await expect(item).toBeVisible()
    await item.click()

    await expectStillOnPagesWithBackgroundTab(page)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(row).toBeFocused()
  })

  test('right click on a page name in a query table opens its menu and not the block menu', async ({
    page,
  }) => {
    await (await queryTablePageName(page)).click({ button: 'right' })

    await expectOnlyOpenInNewTabMenu(page)
  })
})

test.describe('Background tabs on a touch tablet @pages @mobile', () => {
  const tablet = devices['iPad Pro 11 landscape']
  test.use({ viewport: tablet.viewport, hasTouch: true, isMobile: tablet.isMobile })

  test('a long-press on a page name in a query table opens its menu and not the block menu', async ({
    page,
  }) => {
    await waitForBoot(page)
    await queryTablePageName(page)

    // Past the menu's own long-press: CDP touch fires no native `contextmenu`.
    await touchLongPress(page, '[data-testid="query-result"] table [role="link"]', 900)

    await expectOnlyOpenInNewTabMenu(page)
  })
})

test.describe('Ctrl+click opens a link in a background tab, and Alt+Enter follows it @editor @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+click on a link in a block opens it behind the current page', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await inlineLink(page).click({ modifiers: ['ControlOrMeta'] })

    await expectStillOnGettingStartedWithBackgroundTab(page)
  })

  test('Ctrl+click on a link in the block being edited opens it behind the current page', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlockById(page, LINK_BLOCK)

    await page
      .locator('[data-testid="block-editor"] [data-testid="block-link-chip"]')
      .click({ modifiers: ['ControlOrMeta'] })

    await expectStillOnGettingStartedWithBackgroundTab(page)
  })

  test('Ctrl+click on a link in page mode opens it behind the current page', async ({ page }) => {
    await openInPageMode(page)

    await page
      .locator(`${PAGE_MODE_EDITOR} [data-testid="block-link-chip"]`)
      .click({ modifiers: ['ControlOrMeta'] })

    await expectStillOnGettingStartedWithBackgroundTab(page)
  })

  test('Alt+Enter with the caret right after a link in a block follows it', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlockById(page, LINK_BLOCK)
    await page.keyboard.press('ControlOrMeta+End')
    for (const _ of ' for tips.') await page.keyboard.press('ArrowLeft')
    // The editor has taken the caret's move once it draws the link's syntax beside it.
    await expect(page.getByTestId('md-reveal-chip-marker')).toHaveText(['[[', ']]'])

    await page.keyboard.press('Alt+Enter')

    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
    await expect(tabs(page)).toHaveCount(0)
  })

  test('Alt+Enter with the caret right before a link in page mode follows it', async ({ page }) => {
    await openInPageMode(page)
    await page.evaluate((selector) => {
      const { editor } = document.querySelector(selector) as HTMLElement & {
        editor: {
          state: {
            doc: {
              descendants: (f: (node: { type: { name: string } }, pos: number) => void) => void
            }
          }
          commands: { setTextSelection: (pos: number) => boolean }
          view: { focus: () => void }
        }
      }
      let chipPos = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'block_link' && chipPos < 0) chipPos = pos
      })
      editor.commands.setTextSelection(chipPos)
      editor.view.focus()
    }, PAGE_MODE_EDITOR)
    await expect(page.locator(PAGE_MODE_EDITOR)).toBeFocused()

    await page.keyboard.press('Alt+Enter')

    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
    await expect(tabs(page)).toHaveCount(0)
  })
})
