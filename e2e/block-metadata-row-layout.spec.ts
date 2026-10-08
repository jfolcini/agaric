/**
 * #5332 item 9 — a block's metadata chips stay on their own row under its text
 * at every width, the leading controls (task checkbox, drag handle) sit on the
 * FIRST line of a wrapped block, and the page editor and the journal's block
 * views are capped at the 46rem reading width. Item 7: on desktop the control
 * lane hangs in the margin, so a depth-0 checkbox lines up with the heading
 * above the tree. This is geometry, which happy-dom cannot measure, so it
 * asserts real layout boxes.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  expect,
  focusBlockById,
  openPage,
  openPageMobile,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

const PAGE = 'Projects'
const TASK = 'Fix login bug'
const LONG_TEXT = `${TASK} ${'and the session cookie, the redirect loop, the token '.repeat(10)}`
const iPhone13 = devices['iPhone 13']
/** `--container-reading` in `src/index.css`, in CSS px. */
const READING_WIDTH = 46 * 16

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function box(locator: Locator): Promise<Box> {
  const b = await locator.boundingBox()
  expect(b, 'element must have a layout box').not.toBeNull()
  return b as Box
}

/** Vertical centre of each rendered text line, top to bottom. */
function lineCentres(text: Locator): Promise<number[]> {
  return text.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const centres = [...range.getClientRects()]
      .filter((r) => r.width > 0)
      .map((r) => Math.round((r.top + r.height / 2) * 2) / 2)
    return [...new Set(centres)].toSorted((a, b) => a - b)
  })
}

/**
 * The 1px allowance is font rounding, not slack: a line's half-leading can
 * split unevenly, moving the glyph box's centre half a pixel off the line box
 * the controls centre on.
 */
function expectOnLine(b: Box, lineCentre: number, what: string) {
  const offset = Math.abs(b.y + b.height / 2 - lineCentre)
  expect(offset, `${what} centre vs the first text line`).toBeLessThanOrEqual(1)
}

/** Left edge of the first rendered line of an element's text. */
function textLeft(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getClientRects()[0]?.left ?? Number.NaN
  })
}

/**
 * The first depth-0 task's checkbox starts where the heading's text does, and
 * the lane hanging left of it stays clear of the sidebar's resize rail, which
 * reaches into the pane: a grip against the rail turns a near miss into a
 * sidebar resize.
 */
async function expectCheckboxUnderHeading(page: Page, heading: Locator) {
  const todo = page.getByTestId('task-checkbox-todo')
  const row = page.locator('li[aria-level="1"]').filter({ has: todo }).first()
  await expect(row.getByTestId('task-checkbox-todo')).toBeVisible()
  await expect(heading).toBeVisible()
  const offset = (await box(row.getByTestId('task-checkbox-todo'))).x - (await textLeft(heading))
  expect(Math.abs(offset), 'checkbox vs heading text, px').toBeLessThanOrEqual(1)

  const lane = await box(row.locator('.block-control-lane'))
  const rail = await box(page.locator('[data-sidebar="rail"]'))
  expect(lane.x, 'lane left vs the sidebar rail right, px').toBeGreaterThan(rail.x + rail.width)
}

const taskRow = (page: Page) => page.locator('[data-testid="sortable-block"]', { hasText: TASK })

test.describe('Block metadata row layout, desktop (#5332)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
  })

  test('chips sit on their own row under the text, aligned with it', async ({ page }) => {
    const row = taskRow(page)
    const chips = row.getByTestId('block-metadata-row')
    await expect(chips).toBeVisible()
    const textBox = await box(row.getByTestId('block-static'))
    const chipsBox = await box(chips)

    expect(chipsBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height)
    expect(chipsBox.x).toBe(textBox.x)
  })

  test('on a wrapped block, the leading controls stay on the FIRST line', async ({ page }) => {
    const row = taskRow(page)
    const editor = await focusBlockById(page, (await row.getAttribute('data-block-id')) ?? '')
    await editor.fill(LONG_TEXT)
    await saveBlock(page, 'Escape')
    // That Escape leaves the block selected, which hides its task checkbox;
    // a second Escape clears the selection.
    await page.keyboard.press('Escape')
    await expect(row.getByTestId('task-marker')).toBeVisible()

    const lines = await lineCentres(row.getByTestId('block-static'))
    expect(lines.length, 'the block must wrap to 3+ lines').toBeGreaterThanOrEqual(3)
    const firstLine = lines[0] as number

    expectOnLine(await box(row.getByTestId('task-marker')), firstLine, 'checkbox')
    expectOnLine(await box(row.getByTestId('drag-handle')), firstLine, 'drag handle')
  })
})

test.describe('Block metadata row layout, phone (#5332)', () => {
  test.use({
    viewport: iPhone13.viewport,
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('chips stay on their own row under the text', async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, PAGE)

    const row = taskRow(page)
    const chips = row.getByTestId('block-metadata-row')
    await expect(chips).toBeVisible()
    const textBox = await box(row.getByTestId('block-static'))
    const chipsBox = await box(chips)

    expect(chipsBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height)
    expect(chipsBox.x).toBe(textBox.x)
  })
})

test.describe('Reading width, desktop (#5332)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('the page editor is capped at the reading width', async ({ page }) => {
    await openPage(page, PAGE)
    expect((await box(page.locator('.page-editor'))).width).toBe(READING_WIDTH)
  })

  test('journal block views are capped; the month grid keeps the full width', async ({ page }) => {
    const panel = page.getByRole('tabpanel')
    await page.getByRole('tab', { name: 'Daily view' }).click()
    expect((await box(panel)).width).toBe(READING_WIDTH)

    await page.getByRole('tab', { name: 'Monthly view' }).click()
    await expect(page.locator('[role="gridcell"]').first()).toBeVisible()
    expect((await box(panel)).width).toBeGreaterThan(READING_WIDTH)
  })
})

test.describe('Control lane hangs in the margin, desktop (#5332)', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a depth-0 checkbox lines up with the page title', async ({ page }) => {
    await openPage(page, PAGE)
    await expectCheckboxUnderHeading(page, page.getByRole('textbox', { name: 'Page title' }))
  })

  test('a depth-0 checkbox lines up with the journal day heading', async ({ page }) => {
    await page.getByRole('tab', { name: 'Daily view' }).click()
    await expectCheckboxUnderHeading(page, page.getByRole('heading', { level: 1 }))
  })
})
