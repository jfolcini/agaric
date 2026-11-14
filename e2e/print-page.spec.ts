/**
 * Printing a page (#6558): the page kebab's *Print…* opens the webview's print
 * dialog, and the print stylesheet leaves out the app chrome (the sidebar, the
 * header, the page toolbar), lets the page run past one screen instead of
 * clipping it to the scroll area, prints on the light palette whatever the
 * theme, keeps a heading with what follows it, and prints a link's address.
 * Page mode renders every block; block mode fills in its off-screen
 * placeholders on `beforeprint`.
 *
 * Whether the desktop webviews open a print dialog, and fire `beforeprint`, is
 * not something this lane can show; see the issue.
 */

import type { Page } from '@playwright/test'

import { activeMenu, expect, ipc, test, waitForBoot } from './helpers'

const SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
const ROWS = 80
const LAST = `Block number ${ROWS}`
const LINK_URL = 'https://example.com/a'

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
  const firstRows = [`See [[${target}]]`, '## Section', `[the site](${LINK_URL})`]
  for (let n = 1; n <= ROWS; n++) {
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: firstRows[n - 1] ?? `Block number ${n}`,
      parentId: pageId,
      index: null,
      scope: SCOPE,
    })
  }
}

async function openSeeded(page: Page, title: string): Promise<void> {
  await page.keyboard.press('Control+k')
  await page.locator('[cmdk-input]').first().fill(title)
  await page.locator('[cmdk-item]').filter({ hasText: title }).first().waitFor()
  await page.keyboard.press('Enter')
  await expect(page.locator('[aria-label="Page title"]')).toHaveText(title)
}

async function openInPageMode(page: Page, title: string): Promise<void> {
  await openSeeded(page, title)
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

    // A heading stays with what follows it, and a link's address is on the paper.
    expect(
      await page.locator('[data-page-block] h2').evaluate((el) => getComputedStyle(el).breakAfter),
    ).toBe('avoid')
    const address = () =>
      page
        .locator('[data-testid="external-link"]')
        .evaluate((el) => getComputedStyle(el, '::after').content)
    expect(await address()).toContain(LINK_URL)

    // More than one sheet of paper, with every block on one.
    const pdf = (await page.pdf({ format: 'A4' })).toString('latin1')
    expect(pdf.match(/\/Type\s*\/Page\b/g)?.length ?? 0).toBeGreaterThan(1)

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    await page.emulateMedia({ media: 'screen' })
    await expect(page.locator('html')).toHaveClass(/\bdark\b/)
    expect(await address()).toBe('none')
  })

  test('block mode fills in its off-screen rows for the print and drops them after', async ({
    page,
  }) => {
    await seedLongPage(page, 'Print blocks')
    await openSeeded(page, 'Print blocks')
    const placeholders = page.locator('li[data-placeholder]')
    await expect(placeholders).not.toHaveCount(0)
    await expect(page.getByText(LAST, { exact: true })).toHaveCount(0)

    // Read in the task that dispatches `beforeprint`: a real print lays the page
    // out as that event returns, with no frame for the observer to fill rows in.
    const leftAtPrint = await page.evaluate(() => {
      window.dispatchEvent(new Event('beforeprint'))
      return document.querySelectorAll('li[data-placeholder]').length
    })
    expect(leftAtPrint).toBe(0)
    await page.emulateMedia({ media: 'print' })
    await expect(page.getByText(LAST, { exact: true })).toBeVisible()
    expect(await clipped(page, LAST)).toBe(false)
    expect(
      await page
        .locator('[data-testid="external-link"]')
        .evaluate((el) => getComputedStyle(el, '::after').content),
    ).toContain(LINK_URL)

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    await page.emulateMedia({ media: 'screen' })
    await expect(placeholders).not.toHaveCount(0)
  })

  test('the page menu has Print…, which opens the print dialog and closes the menu', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const counter = window as unknown as { printCalls: number }
      counter.printCalls = 0
      window.print = () => {
        counter.printCalls += 1
      }
    })
    await openSeeded(page, 'Getting Started')
    await page.getByRole('button', { name: 'Page actions' }).click()

    await activeMenu(page).getByRole('menuitem', { name: 'Print…' }).click()

    await expect(activeMenu(page)).toHaveCount(0)
    expect(
      await page.evaluate(() => (window as unknown as { printCalls: number }).printCalls),
    ).toBe(1)
  })
})
