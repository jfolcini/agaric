/**
 * The global chords that follow Obsidian's, end to end against the mock:
 * Ctrl+E switches the page between blocks and page mode, Ctrl+Shift+T reopens
 * a closed tab on its page, Ctrl+N selects tab N and Ctrl+9 the last, Ctrl+O
 * and Ctrl+P open the palette's page search and commands (Ctrl+P inside the
 * editor, kept from the WebView's print), Ctrl+Alt+←/→ and the mouse's back
 * and forward buttons step Back / Forward, and Ctrl+L cycles a task.
 */

import type { Page } from '@playwright/test'

import {
  expect,
  focusBlock,
  navigateToView,
  openPage,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

const PAGE_MODE_EDITOR = '[data-testid="page-mode-editor"]'
const pageTitle = (page: Page) => page.locator('[aria-label="Page title"]')

/** Open `title` from the Pages list, which a tab of the same name leaves unambiguous. */
async function openFromPages(page: Page, title: string): Promise<void> {
  await navigateToView(page, 'Pages')
  await page.getByRole('grid').getByText(title, { exact: true }).click()
  await expect(pageTitle(page)).toHaveText(title)
}

test.describe('Obsidian keymap @settings @pages @search', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+E switches the page to page mode and back, from inside the editor', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.press('Control+e')
    const pageModeEditor = page.locator(PAGE_MODE_EDITOR)
    await expect(pageModeEditor).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Page', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    )

    await pageModeEditor.click()
    await page.keyboard.press('Control+e')
    await expect(pageModeEditor).toHaveCount(0)
    await expect(page.locator('[data-testid="block-static"]').first()).toBeVisible()
  })

  test('Ctrl+2 selects the second tab, Ctrl+9 the last, Ctrl+Shift+T reopens a closed one', async ({
    page,
  }) => {
    const tabs = page.getByRole('tab')
    await openFromPages(page, 'Getting Started')
    await page.keyboard.press('Control+t')
    await openFromPages(page, 'Quick Notes')
    await page.keyboard.press('Control+t')
    await openFromPages(page, 'Getting Started')
    await expect(tabs).toHaveText(['Getting Started', 'Quick Notes', 'Getting Started'])

    await page.keyboard.press('Control+2')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(pageTitle(page)).toHaveText('Quick Notes')
    await page.keyboard.press('Control+9')
    await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('Control+2')
    await page.keyboard.press('Control+w')
    await expect(tabs).toHaveText(['Getting Started', 'Getting Started'])

    await page.keyboard.press('Control+Shift+T')
    await expect(tabs).toHaveText(['Getting Started', 'Quick Notes', 'Getting Started'])
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(pageTitle(page)).toHaveText('Quick Notes')
  })

  test('Ctrl+O opens the quick switcher and Ctrl+P the commands, inside the editor, without printing', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    // Registered after the app's own window listener, so it sees what that one did.
    await page.evaluate(() => {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'p' && e.ctrlKey) {
          ;(window as unknown as { printKept?: boolean }).printKept = e.defaultPrevented
        }
      })
    })
    const input = page.getByTestId('command-palette-input')
    const modeChip = page.getByTestId('palette-mode-chip')

    await focusBlock(page)
    await page.keyboard.press('Control+o')
    await expect(input).toBeFocused()
    await expect(modeChip).toHaveText('Search')
    await input.fill('Quick')
    await page
      .getByRole('option', { name: /Quick Notes/ })
      .first()
      .click()
    await expect(pageTitle(page)).toHaveText('Quick Notes')

    await focusBlock(page)
    await page.keyboard.press('Control+p')
    await expect(modeChip).toHaveText('Commands')
    await expect(page.getByTestId('palette-cmd-shortcut-reopenClosedTab')).toBeVisible()
    expect(await page.evaluate(() => (window as { printKept?: boolean }).printKept)).toBe(true)
  })

  test("Ctrl+Alt+←/→ and the mouse's back and forward buttons step Back / Forward", async ({
    page,
  }) => {
    const headerLabel = page.getByTestId('header-label')
    await openPage(page, 'Getting Started')

    await page.keyboard.press('Control+Alt+ArrowLeft')
    await expect(headerLabel).toHaveText('Pages')
    await page.keyboard.press('Control+Alt+ArrowRight')
    await expect(pageTitle(page)).toHaveText('Getting Started')

    const mouseUp = (button: number) =>
      page.evaluate((b) => {
        window.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true }))
      }, button)
    await mouseUp(3)
    await expect(headerLabel).toHaveText('Pages')
    await mouseUp(4)
    await expect(pageTitle(page)).toHaveText('Getting Started')
  })

  test('Ctrl+L makes the block a task, as Ctrl+Enter does', async ({ page }) => {
    await openPage(page, 'Quick Notes')
    await focusBlock(page, 0)
    await page.keyboard.press('Control+l')
    await page.keyboard.press('Escape')

    await reopenPage(page, 'Quick Notes')
    await expect(
      page
        .locator('[data-testid="sortable-block"]')
        .first()
        .locator('[data-testid="task-checkbox-todo"]'),
    ).toBeVisible()
  })
})
