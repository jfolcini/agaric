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
 * E2E for external-link ACTIONS in the editor (#924, finding f5).
 *
 * Prior coverage (external-link-open.spec.ts / external-link-context-menu.spec.ts)
 * only asserted that the open IPC *fired* — never the href it carried — and the
 * "Copy URL" context-menu action had no coverage at all. This spec closes both:
 *
 *   • Ctrl+Click on an `a.external-link` opens the URL via `openUrl` →
 *     `@tauri-apps/plugin-shell` → `plugin:shell|open`, and the IPC `path`
 *     arg equals the link href.
 *   • Right-click → "Copy URL" (BlockContextMenu, only rendered when a
 *     `linkUrl` is present) routes through `writeText` →
 *     `@tauri-apps/plugin-clipboard-manager` → `plugin:clipboard-manager|write_text`,
 *     and the IPC `text` arg equals the link href.
 *
 * Both IPC channels are observed via the `installIpcRecorder` / `getInvokeCalls`
 * helpers (the Tauri mock answers both with null, so nothing throws).
 */

const PAGE = 'Getting Started'
const URL = 'https://example.com/page'

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

test.describe('External link actions in editor (#924 f5)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Click opens the link with the exact href', async ({ page }) => {
    const link = await makeLinkedBlock(page, URL)

    await installIpcRecorder(page)
    await link.click({ modifiers: ['Control'] })

    // openUrl → shell plugin → `plugin:shell|open` with `path` = href.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:shell|open')).length)
      .toBeGreaterThan(0)
    const calls = await getInvokeCalls(page, 'plugin:shell|open')
    expect(calls.some((args) => args['path'] === URL)).toBe(true)
  })

  test('right-click → "Copy URL" writes the href to the clipboard', async ({ page }) => {
    const link = await makeLinkedBlock(page, URL)

    await installIpcRecorder(page)

    // Right-click ON the link to open the block context menu with link-aware items.
    await link.click({ button: 'right' })
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()

    // "Copy URL" comes from the `contextMenu.copyUrl` i18n key → "Copy URL".
    await menu.locator('[role="menuitem"]', { hasText: 'Copy URL' }).click()

    // writeText → clipboard plugin → `plugin:clipboard-manager|write_text`
    // with `text` = href.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:clipboard-manager|write_text')).length)
      .toBeGreaterThan(0)
    const calls = await getInvokeCalls(page, 'plugin:clipboard-manager|write_text')
    expect(calls.some((args) => args['text'] === URL)).toBe(true)
  })
})
