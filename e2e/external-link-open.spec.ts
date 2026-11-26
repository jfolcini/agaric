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
 * `handleClick` plugin prop. `openUrl` routes through the Tauri opener plugin, so
 * we assert the `plugin:opener|open_url` IPC fires (or not) via the recorder.
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

test.describe('Open external link in editor (#924) @editor', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Click on an external link opens the URL', async ({ page }) => {
    const link = await makeLinkedBlock(page, 'https://example.com')

    await installIpcRecorder(page)
    await link.click({ modifiers: ['Control'] })

    // openUrl → Tauri opener plugin → `plugin:opener|open_url` IPC.
    await expect
      .poll(async () => (await getInvokeCalls(page, 'plugin:opener|open_url')).length)
      .toBeGreaterThan(0)
  })

  test('plain click does NOT open the URL (places the caret instead)', async ({ page }) => {
    const link = await makeLinkedBlock(page, 'https://example.com')

    await installIpcRecorder(page)
    await link.click()

    // Give any erroneous open a moment to fire, then assert none did.
    await page.waitForTimeout(400)
    expect((await getInvokeCalls(page, 'plugin:opener|open_url')).length).toBe(0)
  })

  test('the ↗ after a static link never wraps onto a line of its own', async ({ page }) => {
    await makeLinkedBlock(page, 'https://example.com')
    await page.keyboard.press('Escape')
    const link = page.locator('[data-testid="block-static"] [data-testid="external-link"]')
    await expect(link).toBeVisible()

    // Every width from wide to one word: the icon shares a line with the label's last letter.
    const strandedAt = await link.evaluate((el) => {
      const block = el.closest('[data-testid="block-static"]') as HTMLElement
      const icon = el.querySelector('svg') as SVGElement
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (/\p{L}/u.test(n.textContent ?? '')) last = n as Text
      }
      if (last === null) throw new Error('no label text')
      const end = (last.textContent ?? '').trimEnd().length
      const range = document.createRange()
      range.setStart(last, end - 1)
      range.setEnd(last, end)
      const stranded: number[] = []
      for (let width = 400; width >= 40; width -= 1) {
        block.style.width = `${width}px`
        const letter = range.getBoundingClientRect()
        if (icon.getBoundingClientRect().top > letter.bottom) stranded.push(width)
      }
      block.style.width = ''
      return stranded
    })
    expect(strandedAt).toEqual([])
  })
})
