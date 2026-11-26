/**
 * #7040 (S6, S7, S2) — a task reads the same wherever it is listed, and a chip
 * says what it is by its shape:
 *
 * - one task row: checkbox, then title, then metadata, in the Due panel's
 *   groups (Overdue included) and in the Agenda;
 * - a tag is tinted, a property is outlined, a type label is plain text;
 * - a due date and a scheduled date each carry one glyph and one token, on a
 *   block, in a row and in the Week headers.
 *
 * Geometry and computed style, so it runs in a real layout engine.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import { SEED_IDS } from '@/lib/tauri-mock/seed'

import {
  expect,
  expect44,
  ipc,
  navigateToView,
  openPage,
  openSearchView,
  seedSearchBlocks,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'

const PHONE = {
  viewport: { width: 412, height: 915 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
  userAgent: devices['Pixel 7'].userAgent,
}

/** A Wednesday, so the Week view has days on both sides of today. */
const NOW = new Date('2026-10-14T10:00:00')

interface RowBoxes {
  height: number
  /** The checkbox's box. */
  box: { left: number; right: number; centreY: number }
  /** The first line of the title's text. */
  title: { top: number; bottom: number; left: number; right: number }
}

/** The row's height, its checkbox and the first line of `text`, its title. */
function rowBoxes(row: Locator, text: string): Promise<RowBoxes> {
  return row.evaluate((li, title) => {
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent?.includes(title)) node = walker.nextNode()
    if (!node) throw new Error(`the row does not show "${title}"`)
    const range = document.createRange()
    range.selectNodeContents(node)
    const line = range.getClientRects()[0]
    const checkbox = li.querySelector('.task-checkbox')?.getBoundingClientRect()
    if (!line || !checkbox) throw new Error('the row has no title line or no checkbox')
    return {
      height: li.getBoundingClientRect().height,
      box: {
        left: checkbox.left,
        right: checkbox.right,
        centreY: checkbox.top + checkbox.height / 2,
      },
      title: { top: line.top, bottom: line.bottom, left: line.left, right: line.right },
    }
  }, text)
}

async function box(el: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await el.boundingBox()
  if (!b) throw new Error('element has no layout box')
  return b
}

/** `el`'s fill and border as the browser paints them: an alpha of 0 is "none". */
function paint(el: Locator): Promise<{ fill: number; border: number; radius: string }> {
  return el.evaluate((node) => {
    const alpha = (color: string): number => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (!ctx) throw new Error('no 2d context')
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      return ctx.getImageData(0, 0, 1, 1).data[3] ?? 0
    }
    const style = getComputedStyle(node)
    return {
      fill: alpha(style.backgroundColor),
      border: parseFloat(style.borderTopWidth) > 0 ? alpha(style.borderTopColor) : 0,
      radius: style.borderTopLeftRadius,
    }
  })
}

async function openAgenda(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.getByRole('button', { name: /^Journal view mode/ }).click()
    await page.getByRole('button', { name: 'Agenda', exact: true }).click()
  } else {
    await page.getByRole('tab', { name: 'Agenda view' }).click()
  }
  await expect(page.getByTestId('agenda-results-item').first()).toBeVisible()
}

test.describe('One task row on a phone (#7040 S6) @journal @mobile', () => {
  test.use(PHONE)

  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW })
    await waitForBoot(page)
  })

  // Seeded on Projects: "Fix login bug" is DOING and due today; "Ship v2.0
  // release" is TODO, scheduled today and due tomorrow.
  for (const [group, task] of [
    ['DOING', 'Fix login bug'],
    ['TODO', 'Ship v2.0 release'],
  ] as const) {
    test(`a ${group} row in the Due panel is checkbox, title, then chips, in under 60 px`, async ({
      page,
    }) => {
      const row = page.getByTestId('due-panel-item').filter({ hasText: task })
      // Mid-screen, clear of the floating capture button at the bottom corner.
      await row.evaluate((li) => li.scrollIntoView({ block: 'center' }))
      const m = await rowBoxes(row, task)
      // The checkbox sits on the title's line, left of it.
      expect(m.box.centreY, 'checkbox centre, within the title line').toBeGreaterThanOrEqual(
        m.title.top,
      )
      expect(m.box.centreY, 'checkbox centre, within the title line').toBeLessThanOrEqual(
        m.title.bottom,
      )
      expect(m.box.right, 'checkbox right edge vs title left edge').toBeLessThanOrEqual(
        m.title.left,
      )
      expect(m.height, 'row height, px').toBeLessThanOrEqual(60)
      // Its dates are chips under the title, never before it.
      const due = await box(row.locator('[data-date-kind="due"]'))
      expect(due.y, 'due chip top vs title bottom').toBeGreaterThanOrEqual(m.title.bottom - 1)
      // The controls on the chips' line keep a 44 px target as an invisible
      // area: it reaches past the row, over the row after it.
      await expect44(row.locator('[data-date-kind="due"]'), `${group} due chip`)
      await expect44(row.getByTestId('reschedule-btn'), `${group} reschedule button`)
    })
  }

  test('an Agenda row is checkbox, title, then chips, in under 60 px', async ({ page }) => {
    await openAgenda(page, true)
    const row = page.getByTestId('agenda-results-item').filter({ hasText: 'Fix login bug' })
    await row.scrollIntoViewIfNeeded()
    const m = await rowBoxes(row, 'Fix login bug')
    expect(m.box.centreY).toBeGreaterThanOrEqual(m.title.top)
    expect(m.box.centreY).toBeLessThanOrEqual(m.title.bottom)
    expect(m.height, 'row height, px').toBeLessThanOrEqual(60)
    // The date chip follows the title in the document, so a screen reader and
    // a keyboard meet the title first.
    const order = await row.evaluate((li) => {
      const walker = document.createTreeWalker(li, NodeFilter.SHOW_TEXT)
      let title = walker.nextNode()
      while (title && !title.textContent?.includes('Fix login bug')) title = walker.nextNode()
      const chip = [...li.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Oct 14',
      )
      if (!title || !chip) return 'no title or no date chip'
      return title.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'title, chip'
        : 'chip, title'
    })
    expect(order).toBe('title, chip')
    const chip = await box(row.getByText('Oct 14', { exact: true }))
    expect(chip.y, 'date chip top vs title bottom').toBeGreaterThanOrEqual(m.title.bottom - 1)
  })

  test('Overdue and Scheduled earlier tasks are the same rows under a heading, not cards', async ({
    page,
  }) => {
    await seedSearchBlocks(page, [{ content: 'Plan the offsite', todo: 'TODO', scheduled: -1 }])
    await navigateToView(page, 'Agenda')
    await navigateToView(page, 'Journal')
    const panel = page.getByTestId('due-panel')
    await expect(panel.getByRole('heading', { name: /Overdue/ })).toBeVisible()
    await expect(panel.getByRole('heading', { name: /Scheduled earlier/ })).toBeVisible()

    const plain = await paint(panel.getByTestId('due-panel-item').first())
    for (const task of ['Submit report', 'Plan the offsite']) {
      const row = panel.getByRole('listitem').filter({ hasText: task })
      await row.scrollIntoViewIfNeeded()
      // No border and no fill of its own: the row of every other group.
      expect(await paint(row), `"${task}" row paint`).toEqual(plain)
      const m = await rowBoxes(row, task)
      expect(m.box.centreY).toBeGreaterThanOrEqual(m.title.top)
      expect(m.box.centreY).toBeLessThanOrEqual(m.title.bottom)
      expect(m.height, `"${task}" row height, px`).toBeLessThanOrEqual(60)
    }
  })
})

test.describe('One task row on a desktop (#7040 S6) @journal', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW })
    await waitForBoot(page)
  })

  test('an Agenda row reads checkbox, title, then its chips on one line', async ({ page }) => {
    await openAgenda(page, false)
    const row = page.getByTestId('agenda-results-item').filter({ hasText: 'Fix login bug' })
    const m = await rowBoxes(row, 'Fix login bug')
    expect(m.box.right, 'checkbox, then title').toBeLessThanOrEqual(m.title.left)
    const chip = await box(row.getByText('Oct 14', { exact: true }))
    expect(chip.x, 'title, then date chip').toBeGreaterThanOrEqual(m.title.right)
    expect(chip.y + chip.height / 2, 'chip on the title line').toBeGreaterThanOrEqual(m.title.top)
    expect(chip.y + chip.height / 2, 'chip on the title line').toBeLessThanOrEqual(m.title.bottom)
  })
})

test.describe('One date chip (#7040 S2) @journal @editor', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: NOW })
    await waitForBoot(page)
  })

  test('due and scheduled each keep one glyph, and scheduled is neutral, on a block, in a row and in Week', async ({
    page,
  }) => {
    const glyph = (chip: Locator) => chip.locator('svg').first()
    const fill = (chip: Locator) => chip.evaluate((el) => getComputedStyle(el).backgroundColor)

    // The Agenda: "Ship v2.0 release" is scheduled today and due tomorrow.
    await openAgenda(page, false)
    const row = page.getByTestId('agenda-results-item').filter({ hasText: 'Ship v2.0 release' })
    await expect(glyph(row.locator('[data-date-kind="due"]'))).toHaveClass(/lucide-flag/)
    await expect(glyph(row.locator('[data-date-kind="scheduled"]'))).toHaveClass(
      /lucide-calendar-clock/,
    )
    const rowScheduled = await fill(row.locator('[data-date-kind="scheduled"]'))
    // Colour is for urgency: a scheduled date wears a later due date's neutral.
    expect(rowScheduled, 'scheduled fill vs a due date tomorrow').toBe(
      await fill(row.locator('[data-date-kind="due"]')),
    )

    // The Week headers count each kind with the same chip.
    await page.getByRole('tab', { name: 'Weekly view' }).click()
    const today = page.locator('section[id="journal-2026-10-14"]')
    const dueCount = today.getByRole('button', { name: /Due items?, click to view/ })
    const scheduledCount = today.getByRole('button', { name: /Scheduled items?, click to view/ })
    await expect(glyph(dueCount)).toHaveClass(/lucide-flag/)
    await expect(glyph(scheduledCount)).toHaveClass(/lucide-calendar-clock/)
    expect(await fill(scheduledCount), 'scheduled fill: Week header vs Agenda row').toBe(
      rowScheduled,
    )

    // The block itself.
    await openPage(page, 'Projects')
    const block = page.locator('[data-testid="sortable-block"]', { hasText: 'Ship v2.0 release' })
    await expect(glyph(block.locator('.due-date-chip'))).toHaveClass(/lucide-flag/)
    await expect(glyph(block.locator('.scheduled-chip'))).toHaveClass(/lucide-calendar-clock/)
    expect(await fill(block.locator('.scheduled-chip')), 'scheduled fill: block vs row').toBe(
      rowScheduled,
    )
  })
})

test.describe('Chip vocabulary (#7040 S7) @pages @editor @search', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a tag is tinted, a property outlined, a type label plain text', async ({ page }) => {
    await ipc(page, 'add_tag', { blockId: SEED_IDS.PAGE_PROJECTS, tagId: SEED_IDS.TAG_WORK })
    await ipc(page, 'set_property', {
      blockId: SEED_IDS.BLOCK_PROJ_3,
      key: 'effort',
      value: { value_text: '1d' },
    })
    // A tag in a block's text.
    const look = (el: Locator) =>
      el.evaluate((node) => {
        const style = getComputedStyle(node)
        return [style.backgroundColor, style.color, style.borderTopLeftRadius, style.fontWeight]
      })
    await openPage(page, 'Getting Started')
    const inText = await look(
      page
        .getByTestId('tag-ref-chip')
        .filter({ hasText: /^work$/ })
        .first(),
    )

    // A tag: a fill, no outline, and the same chip in the page header as in the text.
    await openPage(page, 'Projects')
    const headerTag = page
      .locator('[data-slot="badge"]')
      .filter({ hasText: /^work$/ })
      .first()
    const tag = await paint(headerTag)
    expect(tag.fill, 'tag fill alpha').toBeGreaterThan(0)
    expect(tag.border, 'tag outline alpha').toBe(0)
    expect(await look(headerTag), 'tag in the page header vs tag in text').toEqual(inText)

    // A property: an outline, no fill.
    const property = await paint(page.getByTestId('property-chip').first())
    expect(property.fill, 'property fill alpha').toBe(0)
    expect(property.border, 'property outline alpha').toBeGreaterThan(0)

    // A type label: neither.
    const input = await openSearchView(page)
    await expect(input).toBeVisible()
    await submitSearch(page, 'Projects')
    const typeLabel = page
      .locator('[data-slot="badge"]')
      .filter({ hasText: /^page$/ })
      .first()
    const label = await paint(typeLabel)
    expect(label.fill, 'type label fill alpha').toBe(0)
    expect(label.border, 'type label outline alpha').toBe(0)
  })
})
