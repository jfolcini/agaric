import { devices, type Locator, type Page } from '@playwright/test'

import {
  activeSheet,
  expect,
  focusBlock,
  navigateMobile,
  openPageMobile,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * #5929 — on a phone, text starts on one left edge: the 16 px gutter the main
 * scroll viewport pads (`App.tsx`). Headings, block text, a sheet's contents
 * and a settings card's contents all sit on it. A task's checkbox does too, and
 * its text follows the checkbox at the gap a desktop row keeps, the text box
 * (the frame while editing) starting clear of the checkbox.
 */

const GUTTER = 16
/** The drawn checkbox and the 16 px from it to the text, as on desktop. */
const TASK_TEXT = GUTTER + 18 + 16

const iPhone13 = devices['iPhone 13']
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

/**
 * Left edge of the first visible text in `loc`, in px from `origin`: the
 * screen edge, or the inside of a container's border.
 */
async function textLeft(loc: Locator, origin?: Locator): Promise<number> {
  const zero = origin
    ? await origin.evaluate((el) => el.getBoundingClientRect().left + el.clientLeft)
    : 0
  const left = await loc.first().evaluate((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement
      if (!node.textContent?.trim() || !el || el.closest('.sr-only')) continue
      if (!el.checkVisibility({ visibilityProperty: true })) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = [...range.getClientRects()].find((r) => r.width > 0)
      if (rect) return rect.left
    }
    throw new Error('no visible text')
  })
  return Math.round(left - zero)
}

function block(page: Page, text: string): Locator {
  return page.locator('[data-testid="block-static"]', { hasText: text })
}

/** Outline, opened on a phone: its title and body sit on the view's gutter. */
async function expectSheetOnGutter(page: Page): Promise<void> {
  await openPageMobile(page, 'Getting Started')
  await page.getByRole('button', { name: 'Page actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Open outline', exact: true }).click()
  const sheet = activeSheet(page)
  await expect(sheet).toBeVisible()

  await expect
    .poll(() => textLeft(sheet.locator('[data-slot="sheet-title"]'), sheet), 'sheet title')
    .toBe(GUTTER)
  const bodyContent = sheet.locator('[data-slot="sheet-body"] [data-radix-scroll-area-viewport]')
  await expect
    .poll(
      () =>
        bodyContent.evaluate((el) => {
          const sheetEl = el.closest('[data-slot="sheet-content"]') as HTMLElement
          const inner =
            el.getBoundingClientRect().left + parseFloat(getComputedStyle(el).paddingLeft)
          return Math.round(inner - sheetEl.getBoundingClientRect().left - sheetEl.clientLeft)
        }),
      'sheet body content',
    )
    .toBe(GUTTER)
}

/**
 * Where the drawn checkbox of the task whose text holds `text` starts, and how
 * far its text box (the editing frame) starts past the checkbox's right edge.
 */
function checkboxEdges(page: Page, text: string): Promise<{ left: number; clear: number }> {
  return page
    .locator('[data-testid="sortable-block"]', { hasText: text })
    .first()
    .evaluate((row) => {
      const box = row.querySelector('.task-checkbox')?.getBoundingClientRect()
      const textBox = row.querySelector('[data-testid="block-static"]')?.getBoundingClientRect()
      if (!box || !textBox) throw new Error('no checkbox or text')
      return { left: Math.round(box.left), clear: Math.round(textBox.left - box.right) }
    })
}

/**
 * How far the drawn checkbox of the task whose text holds `text` sits below
 * the middle of that text's first line, in px.
 */
function checkboxDrop(page: Page, text: string): Promise<number> {
  return page
    .locator('[data-testid="sortable-block"]', { hasText: text })
    .first()
    .evaluate((row) => {
      const box = row.querySelector('.task-checkbox')
      const textBox = row.querySelector('[data-testid="block-static"]')
      if (!box || !textBox) throw new Error('no checkbox or text')
      const walker = document.createTreeWalker(textBox, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const line = [...range.getClientRects()].find((r) => r.width > 0)
        if (!line) continue
        const b = box.getBoundingClientRect()
        return Math.round(b.top + b.height / 2 - (line.top + line.height / 2))
      }
      throw new Error('no visible text')
    })
}

test.describe('One left edge on a phone (#5929) @mobile @journal @pages @settings', () => {
  test.use(PHONE)

  test.beforeEach(async ({ page }) => {
    // The sheet slides in; a position read mid-animation is not where it rests.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  // The header bar names the day on a phone, and the in-content title is
  // screen-reader-only there (#5955), so the block text is the edge to check.
  test('Journal: block and task text sit on the gutter', async ({ page }) => {
    const today = page.locator('section[id^="journal-"]').first()
    await expect(block(page, 'Morning standup')).toBeVisible()

    await expect.poll(() => textLeft(block(page, 'Morning standup')), 'block text').toBe(GUTTER)
    await expect.poll(() => textLeft(block(page, 'Buy groceries')), 'task text').toBe(TASK_TEXT)
    expect(await checkboxEdges(page, 'Buy groceries')).toEqual({ left: GUTTER, clear: 4 })
    // Today's tint runs to the screen edge rather than stopping 4 px short of it.
    await expect.poll(async () => (await today.boundingBox())?.x, 'Today band left edge').toBe(0)
  })

  test("a focused task's editing frame keeps the same inset on both sides", async ({ page }) => {
    await expect(block(page, 'Buy groceries')).toBeVisible()
    await focusBlock(page, 2)
    const row = page.locator('[data-testid="sortable-block"]', { hasText: 'Buy groceries' }).first()
    const frame = row.getByTestId('block-frame')
    await expect(frame).toHaveClass(/block-editing/)

    const { left, right } = await frame.evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right) }
    })
    expect(left).toBeGreaterThan(0)
    expect(left).toBe(right)
    // The checkbox stays on the gutter while its frame moves.
    const checkboxLeft = await row
      .locator('.task-checkbox')
      .evaluate((el) => Math.round(el.getBoundingClientRect().left))
    expect(checkboxLeft).toBe(GUTTER)
  })

  test('a page: the title and block text share the gutter', async ({ page }) => {
    await openPageMobile(page, 'Getting Started')
    await expect(block(page, 'Welcome to Agaric')).toBeVisible()

    await expect
      .poll(() => textLeft(page.locator('[aria-label="Page title"]')), 'page title')
      .toBe(GUTTER)
    await expect.poll(() => textLeft(block(page, 'Welcome to Agaric')), 'block text').toBe(GUTTER)
    const addBlockIcon = page.getByRole('button', { name: 'Add block', exact: true }).locator('svg')
    await expect
      .poll(async () => Math.round((await addBlockIcon.boundingBox())?.x ?? -1), 'Add block icon')
      .toBe(GUTTER)

    await openPageMobile(page, 'Projects')
    await expect.poll(() => textLeft(block(page, 'Ship v2.0 release')), 'task text').toBe(TASK_TEXT)
    expect(await checkboxEdges(page, 'Ship v2.0 release')).toEqual({ left: GUTTER, clear: 4 })
  })

  test('a sheet insets its title and body by the gutter', async ({ page }) => {
    await expectSheetOnGutter(page)
  })

  // Its 44 px box is taller than the line, and once hung below it.
  test("a task's checkbox centres on its first text line", async ({ page }) => {
    await expect(block(page, 'Buy groceries')).toBeVisible()
    expect(await checkboxDrop(page, 'Buy groceries'), 'journal task').toBe(0)
    await openPageMobile(page, 'Projects')
    for (const task of ['Ship v2.0 release', 'Fix login bug', 'Update dependencies']) {
      await expect.poll(() => checkboxDrop(page, task), task).toBe(0)
    }
  })

  test('Settings: a card groups its controls on the gutter, without a second inset', async ({
    page,
  }) => {
    await navigateMobile(page, 'Settings')
    await openSettingsTab(page, 'General')
    const card = page.locator('[data-slot="card"]')
    await expect(card.first()).toBeVisible()
    await expect.poll(() => textLeft(card.first()), 'General card').toBe(GUTTER)

    await openSettingsTab(page, 'App health')
    await expect(page.getByTestId('integrity-panel-title')).toBeVisible()
    await expect
      .poll(() => textLeft(page.getByTestId('integrity-panel-title')), 'App health card')
      .toBe(GUTTER)
    // The metric tiles are the only box left on the phone: their edge is the gutter.
    const tile = page.locator('[data-slot="metric-card"]').first()
    await expect(tile).toBeVisible()
    await expect
      .poll(async () => (await tile.boundingBox())?.x, 'metric tile left edge')
      .toBe(GUTTER)
  })
})

// Under 768 px the app keeps the phone gutter (`p-4 md:p-6`) and picks sheets
// over dialogs (`usePhoneLayout`); a sheet's own gutter once widened at 640.
test.describe('One left edge in a 700 px touch window @mobile @pages', () => {
  test.use({ ...PHONE, viewport: { width: 700, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
  })

  test('a sheet insets its title and body by the gutter', async ({ page }) => {
    await expectSheetOnGutter(page)
  })
})
