/**
 * #7165 U3 — every filter bar has one layout, phone and desktop: the active
 * chips on their own row, above the actions row that starts with Add filter,
 * Add filter shows the funnel, and the view's trailing controls end the row.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  chooseSelectOption,
  expect,
  navigateToView,
  openPage,
  openPageMobile,
  test,
  waitForBoot,
} from './helpers'

const pixel = devices['Pixel 7']
const PHONE = {
  viewport: pixel.viewport,
  userAgent: pixel.userAgent,
  hasTouch: true,
  isMobile: true,
}

async function bottom(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  if (!box) throw new Error('no box')
  return box.y + box.height
}

/** Every chip in `bar` ends above its Add filter button, which carries the funnel. */
async function expectChipsAboveAddFilter(bar: Locator): Promise<void> {
  const addFilter = bar.getByRole('button', { name: 'Add filter', exact: true })
  await expect(addFilter.locator('svg.lucide-funnel')).toHaveCount(1)
  const chips = bar.locator('[data-slot="filter-pill"]')
  await expect(chips.first()).toBeVisible()
  const addFilterBox = await addFilter.boundingBox()
  if (!addFilterBox) throw new Error('Add filter has no box')
  for (const chip of await chips.all()) {
    expect(await bottom(chip)).toBeLessThanOrEqual(addFilterBox.y)
  }
}

/** The view's trailing controls end the actions row, at its inline end. */
async function expectTrailingAtEnd(bar: Locator, trailing: Locator): Promise<void> {
  const row = await bar.locator('[data-slot="filter-bar-actions"]').boundingBox()
  const box = await trailing.boundingBox()
  if (!row || !box) throw new Error('no box')
  expect(Math.abs(row.x + row.width - (box.x + box.width))).toBeLessThanOrEqual(1)
}

interface View {
  name: string
  open: (page: Page, phone: boolean) => Promise<Locator>
  /** The view's trailing controls, when it has any. */
  trailing?: (bar: Locator) => Locator
}

const VIEWS: View[] = [
  {
    // The default "Exclude journal" chip.
    name: 'Graph',
    open: async (page) => {
      await navigateToView(page, 'Graph')
      return page.getByTestId('graph-filter-bar')
    },
    trailing: (bar) => bar.getByTestId('local-graph-control'),
  },
  {
    // The default "Exclude journal pages" chip.
    name: 'Pages',
    open: async (page) => {
      await navigateToView(page, 'Pages')
      return page.getByTestId('page-browser-filter-row')
    },
  },
  {
    // The default status chip.
    name: 'Agenda',
    open: async (page) => {
      await navigateToView(page, 'Agenda')
      return page.getByTestId('agenda-filter-builder')
    },
    trailing: (bar) => bar.getByTestId('agenda-sort-group-controls'),
  },
  {
    name: 'Search',
    open: async (page) => {
      await navigateToView(page, 'Search')
      await page.getByPlaceholder('Search blocks...').fill('tag:#work')
      return page.getByTestId('filter-chip-bar')
    },
  },
  {
    name: 'References',
    open: async (page, phone) => {
      await (phone ? openPageMobile : openPage)(page, 'Getting Started')
      const references = page.getByTestId('linked-references')
      const addFilter = references.getByRole('button', { name: 'Add filter', exact: true })
      await addFilter.scrollIntoViewIfNeeded()
      await addFilter.click()
      await chooseSelectOption(page, 'Filter category', 'Contains')
      await references.getByLabel('Contains text').fill('started')
      await references.getByRole('button', { name: 'Apply filter' }).click()
      return references.locator('.backlink-filter-builder')
    },
    trailing: (bar) => bar.getByRole('group', { name: 'Sort references' }),
  },
]

for (const phone of [false, true]) {
  test.describe(`filter bars on ${phone ? 'a phone' : 'the desktop'} @graph @pages @journal @search @mobile`, () => {
    test.use(phone ? PHONE : { viewport: { width: 1440, height: 900 } })

    test.beforeEach(async ({ page }) => {
      await waitForBoot(page)
    })

    for (const view of VIEWS) {
      test(`${view.name}: the chips sit above Add filter, which shows the funnel; trailing controls end the row`, async ({
        page,
      }) => {
        const bar = await view.open(page, phone)
        await expectChipsAboveAddFilter(bar)
        if (view.trailing) await expectTrailingAtEnd(bar, view.trailing(bar))
      })
    }

    test('Advanced query: Add filter shows the funnel', async ({ page }) => {
      await navigateToView(page, 'Advanced query')
      const addFilter = page.getByRole('button', { name: 'Add filter', exact: true }).first()
      await expect(addFilter.locator('svg.lucide-funnel')).toHaveCount(1)
    })
  })
}
