import {
  expect,
  focusBlockById,
  navigateToView,
  openPage,
  openSettingsTab,
  readClipboard,
  reopenPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * Page-level keyboard chords (#5734): Ctrl+Shift+E (export the page as
 * Markdown), Ctrl+Shift+G (show the page in the local graph), F3 / Shift+F3
 * (step the in-page find match) and the Settings › Editor "Tab indents blocks"
 * switch. The mock-backed build runs each handler unchanged, and its effect
 * (the clipboard, the graph's mode, the find counter, a block's depth and
 * focus) is readable here, so the mock shows each failing.
 *
 * Block ids: `SEED_IDS` in `src/lib/tauri-mock/seed.ts`.
 */

const PAGE = 'Getting Started'
const GS_3 = '0000000000000000000BLOCK03'
const GS_4 = '0000000000000000000BLOCK04'

test.beforeEach(async ({ page }) => {
  await waitForBoot(page)
  await openPage(page, PAGE)
})

test('Ctrl+Shift+E copies the page as Markdown under its title @editor @pages', async ({
  page,
}) => {
  await page.keyboard.press('Control+Shift+E')

  await expect
    .poll(async () => (await readClipboard(page)).split('\n').slice(0, 3))
    .toEqual([
      '# Getting Started',
      '',
      '- Welcome to Agaric! This is your personal knowledge base.',
    ])
})

test('Ctrl+Shift+G opens the graph in local mode on the page @editor @pages', async ({ page }) => {
  await page.keyboard.press('Control+Shift+G')

  await expect(page.getByTestId('local-graph-seed-label')).toHaveText(
    'Showing neighbors of "Getting Started"',
  )
})

test('F3 and Shift+F3 step the active find match @editor @pages', async ({ page }) => {
  await page.keyboard.press('Control+f')
  await page.getByRole('textbox', { name: 'Find in page' }).fill('block')
  const counter = page.getByTestId('in-page-find-counter')
  await expect(counter).toHaveText(/^1 of /)

  await page.keyboard.press('F3')
  await expect(counter).toHaveText(/^2 of /)
  await page.keyboard.press('Shift+F3')
  await expect(counter).toHaveText(/^1 of /)
})

test('the Tab indents blocks switch decides whether Tab indents or moves focus @editor @pages', async ({
  page,
}) => {
  const row = page.locator(`li[data-block-id="${GS_3}"]`)
  const tabSwitch = page.getByRole('switch', { name: 'Tab indents blocks' })

  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  await tabSwitch.click()
  await expect(tabSwitch).not.toBeChecked()

  await openPage(page, PAGE)
  await focusBlockById(page, GS_3)
  await page.keyboard.press('Tab')
  await expect(
    page
      .locator(`li[data-block-id="${GS_4}"]`)
      .getByRole('button', { name: 'Reorder block (drag or use keyboard)' }),
  ).toBeFocused()
  await reopenPage(page, PAGE)
  await expect(row).toHaveAttribute('aria-level', '1')

  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  await tabSwitch.click()
  await expect(tabSwitch).toBeChecked()

  await openPage(page, PAGE)
  const editor = await focusBlockById(page, GS_3)
  await page.keyboard.press('Tab')
  await expect(row).toHaveAttribute('aria-level', '2')
  await expect(editor).toBeFocused()
  await reopenPage(page, PAGE)
  await expect(row).toHaveAttribute('aria-level', '2')
})
