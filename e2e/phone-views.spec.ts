import { devices, type Locator } from '@playwright/test'

import {
  expect,
  focusBlock,
  ipc,
  navigateToView,
  openPageMobile,
  test,
  touchLongPress,
  waitForBoot,
} from './helpers'

/**
 * #5932 — one view each on a 360 px phone: Pages rows give the title the row,
 * History's touch pill stays a small right-aligned pill, an Agenda title keeps
 * its line, the capture button steps aside while editing or scrolling down, and
 * Graph is one surface. Geometry, so it measures real layout boxes.
 */

const iPhone13 = devices['iPhone 13']

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  if (b === null) throw new Error('element has no layout box')
  return b
}

test.describe('Phone views at 360 × 780 (#5932) @mobile @pages @journal @graph', () => {
  test.use({
    viewport: { width: 360, height: 780 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('a Pages row shows a 20-character title whole, and a long press selects it', async ({
    page,
  }) => {
    await waitForBoot(page)
    const id = (await ipc(page, 'create_page_in_space', {
      parentId: null,
      content: 'Quarterly plan draft',
      spaceId: 'SPACE_PERSONAL',
    })) as string
    await navigateToView(page, 'Pages')
    const row = page.locator(`#page-row-${id}`)
    const title = row.locator('.page-browser-item-title')
    await expect(title).toHaveText('Quarterly plan draft')
    const clipped = await title.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(clipped, 'the title is truncated').toBe(false)
    await expect(row.getByRole('checkbox')).toBeHidden()

    await touchLongPress(page, `#page-row-${id} .page-browser-item-title`)
    await expect(row).toHaveAttribute('data-selected', 'true')
    await expect(page.locator('[data-page-item]').getByRole('checkbox').first()).toBeVisible()
    await expect(row.getByRole('checkbox')).toBeChecked()
    // The hold is no tap: the Pages view stays, and its toolbar holds the row actions.
    await expect(page.locator('[aria-label="Page title"]')).toHaveCount(0)
    await expect(page.getByTestId('page-batch-bookmark-btn')).toBeInViewport({ ratio: 1 })
    await expect(page.getByTestId('page-batch-trash-btn')).toBeInViewport({ ratio: 1 })
  })

  test("History's touch pill is a small pill at the list's right edge", async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'History')
    const pill = page.getByTestId('history-touch-nav')
    await expect(pill).toBeVisible()
    const p = await box(pill)
    const list = await box(page.getByRole('grid', { name: 'History entries' }))
    expect(p.width, 'pill width, px').toBeLessThan(120)
    expect(
      Math.abs(p.x + p.width - (list.x + list.width)),
      'pill right vs list right',
    ).toBeLessThan(2)

    // The type select and its "?" share a row; Diff and Reset sit under the text.
    const select = await box(page.locator('#op-type-filter'))
    const help = await box(page.getByTestId('history-filter-legend-trigger'))
    expect(Math.abs(select.y - help.y), 'select top vs "?" top').toBeLessThan(2)
    const item = page.getByTestId('history-item-0')
    const preview = await box(item.locator('.history-item-preview'))
    for (const name of ['Diff', 'Reset']) {
      const button = await box(item.getByRole('button', { name: new RegExp(name) }))
      expect(button.y, `${name} top vs the text's bottom`).toBeGreaterThanOrEqual(
        preview.y + preview.height,
      )
    }
  })

  test('an Agenda row keeps its title on one line', async ({ page }) => {
    await waitForBoot(page)
    const header = page.locator('header').first()
    await header.getByRole('button', { name: /^Journal view mode/ }).click()
    await page.getByRole('button', { name: 'Agenda', exact: true }).click()
    const text = page
      .getByTestId('agenda-results-item')
      .filter({ hasText: 'Review pull requests' })
      .locator('.agenda-results-text')
    await expect(text).toBeVisible()
    const lines = await text.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return new Set(
        [...range.getClientRects()].filter((r) => r.height > 0).map((r) => Math.round(r.top)),
      ).size
    })
    expect(lines, 'title lines').toBe(1)
  })

  test('the capture button is 56 px, hides while editing and scrolling down, and returns on a scroll up or a new screen', async ({
    page,
  }) => {
    await waitForBoot(page)
    const fab = page.getByTestId('quick-capture-fab')
    await expect(fab).toBeVisible()
    const b = await box(fab)
    expect([b.width, b.height], 'FAB size, px').toEqual([56, 56])

    for (let i = 0; i < 30; i++) {
      await ipc(page, 'create_page_in_space', {
        parentId: null,
        content: `Scroll page ${i}`,
        spaceId: 'SPACE_PERSONAL',
      })
    }
    await navigateToView(page, 'Pages')
    await expect(page.locator('[data-page-item]').first()).toBeVisible()
    await page.mouse.move(180, 500)
    await page.mouse.wheel(0, 300)
    await expect(fab).toBeHidden()
    await page.mouse.wheel(0, -100)
    await expect(fab).toBeVisible()
    await page.mouse.wheel(0, 300)
    await expect(fab).toBeHidden()

    // A new screen brings it back; editing a block hides it again.
    await openPageMobile(page, 'Getting Started')
    await expect(page.getByTestId('block-static').first()).toBeVisible()
    await expect(fab).toBeVisible()
    await page.mouse.wheel(0, 600)
    await page.mouse.wheel(0, -60)
    await expect(fab).toBeVisible()
    await page.mouse.wheel(0, 60)
    await expect(fab).toBeHidden()

    // Back to a scrolled screen restores its position, which is not a scroll down.
    await navigateToView(page, 'Pages')
    await expect(fab).toBeVisible()
    // A phone goes back with the system gesture, which the header's Back button
    // (hidden below `md`, #5926) stands in for here: same `goBack`.
    await page.locator('button[aria-label="Back"]').dispatchEvent('click')
    await expect
      .poll(() => page.evaluate(() => document.getElementById('main-content')?.scrollTop))
      .toBeGreaterThan(0)
    // An absence check: the scroll event of a restore arrives a frame after it sets the
    // position, and nothing marks "no hide came", so this is many frames, not a sync point.
    await page.waitForTimeout(1000)
    await expect(fab).toBeVisible()
    await focusBlock(page, 0)
    await expect(fab).toBeHidden()
  })

  test('Graph is one bordered surface', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Graph')
    const graph = page.getByTestId('graph-view')
    await expect(page.getByTestId('local-graph-control')).toBeVisible()
    const surfaces = await graph.evaluate((root) =>
      [root, ...root.querySelectorAll('*')]
        .filter((el) => el.tagName !== 'BUTTON' && !el.closest('button, svg'))
        .filter((el) => {
          const s = getComputedStyle(el)
          return (
            s.borderTopStyle !== 'none' &&
            parseFloat(s.borderTopWidth) > 0 &&
            s.borderTopColor !== 'rgba(0, 0, 0, 0)'
          )
        })
        .map((el) => el.getAttribute('data-testid') ?? el.className),
    )
    expect(surfaces, 'bordered surfaces').toEqual(['graph-view'])
  })
})
