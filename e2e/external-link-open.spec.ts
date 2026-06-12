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
 * E2E for opening an external link while editing (#924). `openOnClick:false` is
 * intentional (a plain click places the caret so the link text stays editable);
 * the editor now opens the URL on Ctrl/Cmd+Click via the ExternalLink
 * `handleClick` plugin prop. `openUrl` routes through the Tauri shell plugin, so
 * we assert the `plugin:shell|open` IPC fires (or not) via the recorder.
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

test.describe('Open external link in editor (#924)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Click on an external link opens the URL', async ({ page }) => {
    const link = await makeLinkedBlock(page, 'https://example.com')

    await installIpcRecorder(page)
    await link.click({ modifiers: ['Control'] })

    // openUrl → Tauri shell plugin → `plugin:shell|open` IPC.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:shell|open')).length)
      .toBeGreaterThan(0)
  })

  test('plain click does NOT open the URL (places the caret instead)', async ({ page }) => {
    const link = await makeLinkedBlock(page, 'https://example.com')

    await installIpcRecorder(page)
    await link.click()

    // Give any erroneous open a moment to fire, then assert none did.
    await page.waitForTimeout(400)
    expect((await getInvokeCalls(page, 'plugin:shell|open')).length).toBe(0)
  })
})
