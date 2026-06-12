import {
  expect,
  focusBlock,
  getInvokeCalls,
  installIpcRecorder,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E for the "Open link" / "Copy link URL" block context-menu items (#924,
 * finding 1 secondary half). This is the discoverable, non-modifier counterpart
 * to the Ctrl/Cmd+Click open path (`external-link-open.spec.ts`): right-clicking
 * an external link inside a block surfaces the block context menu with an
 * "Open link" item that routes through `openUrl` → Tauri shell plugin, asserted
 * via the `plugin:shell|open` IPC recorder.
 */

const PAGE = 'Getting Started'

/** Create a block whose whole content is a link to `url`, return its locator. */
async function makeLinkedBlock(page: import('@playwright/test').Page, url: string) {
  await openPage(page, PAGE)
  await focusBlock(page)
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: 'External link' }).click()
  const urlInput = page.getByPlaceholder('https://...')
  await expect(urlInput).toBeVisible()
  await urlInput.fill(url)
  await urlInput.press('Enter')
  const link = page.locator('[data-testid="block-editor"] [data-testid="external-link"]')
  await expect(link).toBeVisible()
  return link
}

test.describe('Open external link via block context menu (#924)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('right-click → "Open link" opens the URL', async ({ page }) => {
    const link = await makeLinkedBlock(page, 'https://example.com')

    await installIpcRecorder(page)

    // Right-click ON the external link to open the block context menu with the
    // link-aware items.
    await link.click({ button: 'right' })

    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()

    await menu.locator('[role="menuitem"]', { hasText: 'Open link' }).click()

    // openUrl → Tauri shell plugin → `plugin:shell|open` IPC.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:shell|open')).length)
      .toBeGreaterThan(0)
  })

  test('right-click on a non-link block does NOT offer "Open link"', async ({ page }) => {
    await openPage(page, PAGE)
    await focusBlock(page)
    await page.keyboard.type('a plain block with no link')

    await page.locator('[data-testid="sortable-block"]').first().click({ button: 'right' })

    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.locator('[role="menuitem"]', { hasText: 'Open link' })).toHaveCount(0)
  })
})
