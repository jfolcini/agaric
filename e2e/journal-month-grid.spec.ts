import { devices, type Locator } from '@playwright/test'

import { expect, navigateToView, seedSearchBlocks, test, waitForBoot } from './helpers'

/**
 * The Journal's Month grid on a phone (#7040 P2): gridlines run between the
 * week rows as well as between the days, a day's count sits beside its dots,
 * and a tap still opens that day. The grid is pure layout over the mock's
 * agenda counts, so the mock lane shows it failing.
 *
 * The tasks are in next month, past every seeded task (due at most a week from
 * today), so the dotted day carries exactly the two seeded here.
 */

const pixel = devices['Pixel 7']
const PHONE = {
  viewport: { width: 412, height: 915 },
  userAgent: pixel.userAgent,
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 1,
}

const now = new Date()
const DAY = new Date(now.getFullYear(), now.getMonth() + 1, 12)
const DAY_ISO = `${DAY.getFullYear()}-${String(DAY.getMonth() + 1).padStart(2, '0')}-12`

test.use(PHONE)

/** How far the count `n` sits right of the cell's last dot, and how far off its line. */
function countBesideDot(cell: Locator, n: number): Promise<{ gap: number; offLine: number }> {
  return cell.evaluate((el, text) => {
    const dot = [...el.querySelectorAll('span[aria-hidden="true"]')].at(-1)
    const count = [...el.querySelectorAll('span')].find((s) => s.textContent === text)
    if (!dot || !count) throw new Error('no dot and count in the cell')
    const d = dot.getBoundingClientRect()
    const c = count.getBoundingClientRect()
    return {
      gap: c.left - d.right,
      offLine: Math.abs(c.top + c.height / 2 - (d.top + d.height / 2)),
    }
  }, String(n))
}

/**
 * The colours painted across the line between two days and across the line
 * between two weeks, other than the cells' own fill. Measured and sampled in one
 * pass, a point every quarter pixel: a 1px line can sit between two whole pixels.
 */
function gridlinePaint(grid: Locator): Promise<{ day: string[]; week: string[] }> {
  return grid.evaluate((el) => {
    const paintAt = (x: number, y: number): string => {
      for (let at = document.elementFromPoint(x, y); at; at = at.parentElement) {
        const bg = getComputedStyle(at).backgroundColor
        if (bg !== 'rgba(0, 0, 0, 0)') return bg
      }
      return 'none'
    }
    const across = (x0: number, y0: number, x1: number, y1: number, fill: string): string[] => {
      const seen = new Set<string>()
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 4)
      for (let i = 0; i <= steps; i++) {
        seen.add(paintAt(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps))
      }
      seen.delete(fill)
      return [...seen]
    }
    const rows = el.querySelectorAll('[role="row"]')
    const rect = (row: number, col: number): DOMRect => {
      const cell = rows[row]?.children[col]
      if (!cell) throw new Error(`no cell at row ${row}, column ${col}`)
      return cell.getBoundingClientRect()
    }
    const above = rect(2, 3)
    const below = rect(3, 3)
    const right = rect(2, 4)
    const midX = above.x + above.width / 2
    const midY = above.y + above.height / 2
    const fill = paintAt(midX, midY)
    return {
      day: across(above.right - 2, midY, right.left + 2, midY, fill),
      week: across(midX, above.bottom - 2, midX, below.top + 2, fill),
    }
  })
}

test('Month on a phone draws gridlines between weeks, puts each count beside its dots, and a tap opens the day @mobile @journal', async ({
  page,
}) => {
  await waitForBoot(page)
  await seedSearchBlocks(page, [
    { content: `Due on ${DAY_ISO}`, todo: 'TODO', due: DAY_ISO },
    { content: `Scheduled on ${DAY_ISO}`, todo: 'TODO', scheduled: DAY_ISO },
  ])
  await navigateToView(page, 'Journal')
  await page.getByRole('button', { name: /^Journal view mode/ }).click()
  await page.getByRole('button', { name: 'Month', exact: true }).click()
  await page.getByRole('button', { name: 'Next month' }).click()

  const grid = page.getByRole('grid', { name: 'Monthly calendar' })
  const cell = grid.locator(`[role="gridcell"][data-date="${DAY_ISO}"]`)
  await expect(cell).toHaveAccessibleName(/, 2 agenda items$/)

  // The count follows the last dot on the same line.
  const { gap, offLine } = await countBesideDot(cell, 2)
  expect.soft(gap).toBeGreaterThanOrEqual(0)
  expect.soft(gap).toBeLessThanOrEqual(6)
  expect.soft(offLine).toBeLessThanOrEqual(3)

  // The line between two week rows is painted like the line between two days.
  await expect(async () => {
    const { day, week } = await gridlinePaint(grid)
    expect(day).toHaveLength(1)
    expect(week).toEqual(day)
  }).toPass({ timeout: 5000 })

  // A tap still opens that day.
  await cell.tap()
  await expect(page.getByRole('button', { name: /^Journal view mode: Day/ })).toBeVisible()
  await expect(page.getByTestId('date-display')).toHaveText(
    DAY.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
  )
  await expect(page.getByText(`Due on ${DAY_ISO}`)).toBeVisible()
})
