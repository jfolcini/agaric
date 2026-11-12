/**
 * The print stylesheet (#6558): printing a page leaves out the app chrome (the
 * sidebar, the header, the page toolbar), lets the page run past one screen
 * instead of clipping it to the scroll area, and prints on the light palette
 * whatever the theme. Page mode renders every block, so a block far below the
 * fold prints; block mode renders rows off screen as empty placeholders.
 *
 * Whether the desktop webviews open a print dialog at all is not something
 * this lane can show; see the issue.
 */

import type { Page } from '@playwright/test'

import { expect, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const ROWS = 80
const LAST = `Block number ${ROWS}`

async function seedLongPage(page: Page, title: string): Promise<void> {
  const pageId = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: title,
    spaceId: SCOPE.space_id,
  })
  const target = await ipc<string>(page, 'create_page_in_space', {
    parentId: null,
    content: 'Linked target',
    spaceId: SCOPE.space_id,
  })
  for (let n = 1; n <= ROWS; n++) {
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: n === 1 ? `See [[${target}]]` : `Block number ${n}`,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
  }
}

async function openInPageMode(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
  await page
    .getByRole('radiogroup', { name: 'Editing mode' })
    .getByRole('radio', { name: 'Page' })
    .click()
  await expect(page.locator('[data-testid="page-mode-editor"] [data-page-block]')).toHaveCount(ROWS)
}

/** Whether an ancestor with clipping overflow cuts `text` off. */
function clipped(page: Page, text: string): Promise<boolean> {
  return page.getByText(text, { exact: true }).evaluate((el) => {
    const box = el.getBoundingClientRect()
    for (let up = el.parentElement; up !== null; up = up.parentElement) {
      const style = getComputedStyle(up)
      if (style.overflowY === 'visible' && style.overflowX === 'visible') continue
      const frame = up.getBoundingClientRect()
      if (box.bottom > frame.bottom + 1 || box.top < frame.top - 1) return true
    }
    return false
  })
}

test.describe('printing a page @pages @editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('theme-preference', 'dark'))
    await waitForBoot(page)
  })

  test('hides the chrome, runs past one screen and prints light', async ({ page }) => {
    await seedLongPage(page, 'Print me')
    await openInPageMode(page, 'Print me')
    await page.emulateMedia({ media: 'print' })
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')))

    await expect(page.locator('[data-slot="sidebar"]')).toBeHidden()
    await expect(page.locator('[data-slot="sidebar-inset"] > header')).toBeHidden()
    await expect(page.getByRole('radiogroup', { name: 'Editing mode' })).toBeHidden()
    await expect(page.locator('[data-slot="sidebar-inset"] [role="toolbar"]')).toBeHidden()
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
    await expect(page.getByText(LAST, { exact: true })).toBeVisible()
    expect(await clipped(page, LAST)).toBe(false)

    // The light palette: dark text on a light ground, link chips included.
    const lightness = (selector: string, property: 'color' | 'backgroundColor') =>
      page
        .locator(selector)
        .first()
        .evaluate((el, prop) => {
          const probe = document.createElement('canvas').getContext('2d')
          if (probe === null) throw new Error('no canvas')
          probe.fillStyle = getComputedStyle(el)[prop]
          probe.fillRect(0, 0, 1, 1)
          const [r, g, b] = probe.getImageData(0, 0, 1, 1).data
          return ((r ?? 0) + (g ?? 0) + (b ?? 0)) / 3
        }, property)
    expect(await lightness('body', 'backgroundColor')).toBeGreaterThan(200)
    expect(await lightness('[data-page-block]', 'color')).toBeLessThan(100)
    expect(await lightness('[data-testid="block-link-chip"]', 'color')).toBeLessThan(100)

    // More than one sheet of paper, with every block on one.
    const pdf = (await page.pdf({ format: 'A4' })).toString('latin1')
    expect(pdf.match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThan(1)

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    await page.emulateMedia({ media: 'screen' })
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  })
})
