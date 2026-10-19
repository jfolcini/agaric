import { devices, type Locator, type Page } from '@playwright/test'

import { expect, openPage, openPageMobile, reopenPage, test, waitForBoot } from './helpers'

/**
 * #5928 — block lists on a phone spend no height on what is not shown: a task
 * row's chips keep 44 px hit areas without growing the row, the drop zone after
 * the last block takes room only while a drag is on, and an empty day in Week
 * view is one row. Geometry, so it measures real layout boxes.
 */

const iPhone13 = devices['iPhone 13']
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

async function height(locator: Locator): Promise<number> {
  const b = await locator.boundingBox()
  expect(b, 'element must have a layout box').not.toBeNull()
  return (b as { height: number }).height
}

/** Whether a tap 20 px above and below the element's centre lands on it. */
function hitsOffCentre(el: Locator): Promise<boolean[]> {
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    return [-20, 20].map((dy) => node.contains(document.elementFromPoint(cx, cy + dy)))
  })
}

test.describe('Block lists on a phone (#5928) @editor @journal @mobile', () => {
  test.use(PHONE)

  test('a task row with chips stays compact and its chips keep 44 px hit areas', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPageMobile(page, 'Projects')
    const row = page.locator('[data-testid="sortable-block"]', { hasText: 'Fix login bug' })
    await expect(row.getByTestId('block-metadata-row')).toBeVisible()

    expect(await height(row), 'task row height, px').toBeLessThanOrEqual(64)
    // The chips read as their own task's: nearer its title than the next block's.
    const gaps = await row.evaluate((el) => {
      const text = (block: Element | undefined) => {
        const range = document.createRange()
        range.selectNodeContents(block?.querySelector('[data-testid="block-static"]') as Node)
        const lines = [...range.getClientRects()].filter((r) => r.height > 0)
        return {
          top: Math.min(...lines.map((r) => r.top)),
          bottom: Math.max(...lines.map((r) => r.bottom)),
        }
      }
      const rows = [...document.querySelectorAll('[data-testid="sortable-block"]')]
      const chipBoxes = [
        ...(el.querySelector('[data-testid="block-metadata-row"]')?.children ?? []),
      ].map((chip) => chip.getBoundingClientRect())
      if (chipBoxes.length === 0) throw new Error('the task row has no chips')
      const chips = {
        top: Math.min(...chipBoxes.map((r) => r.top)),
        bottom: Math.max(...chipBoxes.map((r) => r.bottom)),
      }
      return {
        toOwnTitle: chips.top - text(el).bottom,
        toNextTitle: text(rows[rows.indexOf(el) + 1]).top - chips.bottom,
      }
    })
    expect(gaps.toOwnTitle, 'chips gap to own title vs next title, px').toBeLessThan(
      gaps.toNextTitle,
    )
    expect(await hitsOffCentre(row.locator('.due-date-chip')), 'due chip hit area').toEqual([
      true,
      true,
    ])
    expect(await hitsOffCentre(row.getByTestId('priority-badge')), 'priority hit area').toEqual([
      true,
      true,
    ])
  })

  test('an empty Week day is one row', async ({ page }) => {
    await waitForBoot(page)
    const header = page.locator('header').first()
    await header.getByRole('button', { name: /^Journal view mode/ }).click()
    await page.getByRole('button', { name: 'Week', exact: true }).click()

    // The seed has a journal page for today only, so the other six days are empty.
    const emptyDays = page.locator('section[id^="journal-"]', { hasText: 'No blocks for' })
    await expect(emptyDays).toHaveCount(6)
    for (const day of await emptyDays.all()) {
      await day.scrollIntoViewIfNeeded()
      await expect(day.getByRole('button', { name: 'Add block', exact: true })).toBeVisible()
      expect(await height(day), `${await day.getAttribute('id')} height, px`).toBeLessThanOrEqual(
        56,
      )
    }
  })
})

const PAGE = 'Getting Started'

function blockIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="sortable-block"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-block-id') ?? ''))
}

test.describe('Drop after the last block (#5928) @editor', () => {
  test('a block dragged below the last one lands last, through a drop zone that grows for the drag', async ({
    page,
  }) => {
    await waitForBoot(page)
    await openPage(page, PAGE)
    const rows = page.locator('[data-testid="sortable-block"]')
    const sentinel = page.locator('ul[data-testid="block-tree"] > li[aria-hidden]')
    const [first] = await blockIds(page)
    if (first === undefined) throw new Error('the page has no blocks')
    // At rest the drop zone takes no room.
    expect(await height(sentinel)).toBe(0)

    await rows.first().hover()
    const handle = rows.first().getByTestId('drag-handle')
    const from = await handle.boundingBox()
    const last = await rows.last().boundingBox()
    if (!from || !last) throw new Error('no layout box for the handle or the last row')
    const sx = from.x + from.width / 2
    const sy = from.y + from.height / 2
    const ty = last.y + last.height + 30
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    for (let i = 1; i <= 20; i++) await page.mouse.move(sx, sy + ((ty - sy) * i) / 20)

    expect(await height(sentinel), 'drop zone height during the drag, px').toBeGreaterThanOrEqual(
      60,
    )
    await expect(sentinel.locator('.drop-indicator')).toBeVisible()
    await page.mouse.up()
    await expect(sentinel.locator('.drop-indicator')).toHaveCount(0)

    await reopenPage(page, PAGE)
    await expect.poll(async () => (await blockIds(page)).at(-1)).toBe(first)
  })
})
