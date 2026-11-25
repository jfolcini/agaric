/**
 * List views read at one capped, centred width (`max-w-list`, #6544) instead
 * of running full-bleed: at 1440 px a Pages row's title and its metadata sat
 * a thousand pixels apart. A view's header in the outlet above the scroller
 * takes the same column. A phone's views are narrower than the cap and keep
 * the full width.
 *
 * The view's root is the first child of the view wrapper, its header the
 * first child of the header outlet. On a desktop the header's hairline is the
 * header's own, so it runs the width of the column the header sits in, not the
 * window's (S4, #7040); a touch phone's outlet draws its own, edge to edge
 * (`phone-view-headers.spec.ts`).
 */

import type { Locator, Page } from '@playwright/test'

import {
  expect,
  expectViewLoaded,
  navigateToView,
  openPage,
  type TopLevelView,
  test,
  waitForBoot,
} from './helpers'

const LIST_WIDTH = 960
const LIST_VIEWS: { view: TopLevelView; header: boolean }[] = [
  { view: 'Pages', header: true },
  { view: 'Search', header: true },
  { view: 'Tags', header: false },
  { view: 'Templates', header: false },
  { view: 'Advanced query', header: false },
  { view: 'Trash', header: false },
  { view: 'History', header: true },
]

function viewRoot(page: Page): Locator {
  return page.getByTestId('view-transition-wrapper').locator('> *').first()
}

function viewHeader(page: Page): Locator {
  return page.locator('[data-testid="view-header-outlet"]:visible > *').first()
}

function headerOutlet(page: Page): Locator {
  return page.locator('[data-testid="view-header-outlet"]:visible')
}

/** `box` is at most the list width and has equal room on both sides inside `within`. */
async function expectCappedAndCentred(box: Locator, within: Locator, label: string) {
  const [inner, outer] = await Promise.all([box.boundingBox(), within.boundingBox()])
  if (inner === null || outer === null) throw new Error(`${label}: not laid out`)
  expect(inner.width, `${label} width`).toBeLessThanOrEqual(LIST_WIDTH)
  // The view is narrower than its column at 1440 px, so the cap took effect.
  expect(outer.width, `${label} column`).toBeGreaterThan(LIST_WIDTH)
  const left = inner.x - outer.x
  const right = outer.x + outer.width - (inner.x + inner.width)
  expect(Math.abs(left - right), `${label} centred`).toBeLessThanOrEqual(1)
}

test.describe('list views at 1440 px @pages @search', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  for (const { view, header } of LIST_VIEWS) {
    test(`${view} is capped and centred`, async ({ page }) => {
      await waitForBoot(page)
      await navigateToView(page, view)
      await expectViewLoaded(page, view)

      await expectCappedAndCentred(
        viewRoot(page),
        page.getByTestId('view-transition-wrapper'),
        `${view} content`,
      )
      if (header) {
        await expectCappedAndCentred(
          viewHeader(page),
          page.locator('[data-testid="view-header-outlet"]:visible'),
          `${view} header`,
        )
        await expect(viewHeader(page)).toHaveCSS('border-bottom-width', '1px')
        await expect(headerOutlet(page)).toHaveCSS('border-bottom-width', '0px')
      }
    })
  }

  test('a page header is capped, centred and ruled at the column @pages', async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
    await expect(headerOutlet(page).locator('.page-header')).toBeVisible()
    await expectCappedAndCentred(viewHeader(page), headerOutlet(page), 'page header')
    await expect(viewHeader(page)).toHaveCSS('border-bottom-width', '1px')
    await expect(headerOutlet(page)).toHaveCSS('border-bottom-width', '0px')
  })
})

test('a list view keeps the full width on a phone @pages @mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await waitForBoot(page)
  await navigateToView(page, 'Pages')
  await expectViewLoaded(page, 'Pages')

  const [root, column] = await Promise.all([
    viewRoot(page).boundingBox(),
    page.getByTestId('view-transition-wrapper').boundingBox(),
  ])
  expect(root?.width).toBe(column?.width)
})
