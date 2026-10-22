import type { Locator, Page } from '@playwright/test'

import { expect, navigateToView, openPage, test, waitForBoot } from './helpers'

/**
 * The tab strip (#5691): a middle click on a tab closes it, and a tab moves by
 * drag or by Space, arrows, Space. The order is the tabs store's, kept in
 * `agaric:tabs` like the tabs themselves.
 */

function tabs(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Editor tabs' }).getByRole('tab')
}

/** Getting Started in front, Quick Notes and Projects in background tabs behind it. */
async function openThreeTabs(page: Page): Promise<void> {
  await openPage(page, 'Getting Started')
  await navigateToView(page, 'Pages')
  for (const title of ['Quick Notes', 'Projects']) {
    await page.locator('.page-browser-item', { hasText: title }).click({ button: 'middle' })
  }
  await tabs(page).first().click()
  await expect(tabs(page)).toHaveText(['Getting Started', 'Quick Notes', 'Projects'])
  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
}

/** A mouse drag along the strip, from the middle of `source` to the middle of `target`. */
async function dragAlongStrip(page: Page, source: Locator, target: Locator): Promise<void> {
  const from = await source.boundingBox()
  const to = await target.boundingBox()
  if (!from || !to) throw new Error('dragAlongStrip: a tab has no layout box')
  const [dragged, over] = [await source.textContent(), await target.textContent()]
  const y = from.y + from.height / 2
  await page.mouse.move(from.x + from.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, y, { steps: 20 })
  // Release once dnd-kit has settled on the target tab.
  await expect(
    page.getByRole('status').filter({ hasText: `${dragged} moved over ${over}.` }),
  ).toBeAttached()
  await page.mouse.up()
  // dnd-kit swallows every click until a 50 ms timer set at the drop runs, to
  // eat the drop's own; a click sent at machine speed beats that timer. A 50 ms
  // timer set after the drop runs after it.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
}

test.describe('Tab strip: middle click and reorder (#5691) @pages', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openThreeTabs(page)
  })

  test('a middle click closes the tab and leaves the page on screen', async ({ page }) => {
    await tabs(page).nth(1).click({ button: 'middle' })

    await expect(tabs(page)).toHaveText(['Getting Started', 'Projects'])
    await expect(tabs(page).first()).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  })

  test('a drag moves a tab, and the order holds across views and a reload', async ({ page }) => {
    await dragAlongStrip(page, tabs(page).nth(0), tabs(page).nth(2))

    await expect(tabs(page)).toHaveText(['Quick Notes', 'Projects', 'Getting Started'])
    // A drag is not a click: the active tab and its page stay.
    await expect(tabs(page).nth(2)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')

    await navigateToView(page, 'Journal')
    await expect(page.getByTestId('journal-header')).toBeVisible()
    await tabs(page).nth(0).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes')
    await expect(tabs(page)).toHaveText(['Quick Notes', 'Projects', 'Getting Started'])

    await page.reload()
    await expect(tabs(page)).toHaveText(['Quick Notes', 'Projects', 'Getting Started'])
  })

  test('Space, arrows, Space moves the focused tab and keeps it active', async ({ page }) => {
    const active = tabs(page).first()
    await active.focus()
    await expect(active).toBeFocused()

    // Each arrow moves from where the last one left the tab, once its move is announced.
    const announced = (text: string) => page.getByRole('status').filter({ hasText: text })
    await page.keyboard.press('Space')
    // dnd-kit's keyboard sensor starts listening on a timer the Space sets; an
    // arrow sent at machine speed beats it. A timer set after the Space runs after it.
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)))
    await page.keyboard.press('ArrowRight')
    await expect(announced('Getting Started moved over Quick Notes.')).toBeAttached()
    await page.keyboard.press('ArrowRight')
    await expect(announced('Getting Started moved over Projects.')).toBeAttached()
    await page.keyboard.press('Space')
    await expect(announced('Getting Started dropped over Projects.')).toBeAttached()

    await expect(tabs(page)).toHaveText(['Quick Notes', 'Projects', 'Getting Started'])
    await expect(tabs(page).nth(2)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs(page).nth(2)).toBeFocused()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  })
})
