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

/**
 * The view's trailing controls end the actions row at the bar's inline end, or
 * a row of their own below it once they do not fit beside it.
 */
async function expectTrailingAtEnd(bar: Locator, trailing: Locator): Promise<void> {
  const end = await bar.boundingBox()
  const row = await bar.locator('[data-slot="filter-bar-actions"]').boundingBox()
  const box = await trailing.boundingBox()
  if (!end || !row || !box) throw new Error('no box')
  expect(Math.abs(end.x + end.width - (box.x + box.width))).toBeLessThanOrEqual(1)
  expect(box.y + box.height / 2).toBeGreaterThanOrEqual(row.y)
}

interface View {
  name: string
  open: (page: Page, phone: boolean) => Promise<Locator>
  /** The view's trailing controls, when it has any. */
  trailing?: (bar: Locator) => Locator
}

const VIEWS: View[] = [
  {
    // The default "Exclude journal" chip. Focus on this page sits beside the
    // bar, outside its error boundary.
    name: 'Graph',
    open: async (page) => {
      await navigateToView(page, 'Graph')
      return page.getByTestId('graph-tag-filter')
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

    test('References: Source pages follows Add filter; the header line holds only its toggle', async ({
      page,
    }) => {
      await (phone ? openPageMobile : openPage)(page, 'Getting Started')
      const references = page.getByTestId('linked-references')
      const actions = references.locator('[data-slot="filter-bar-actions"]')
      await actions.scrollIntoViewIfNeeded()
      await expect(actions.locator(':scope > button')).toHaveText(['Add filter', 'Source pages'])
      const source = actions.getByRole('button', { name: 'Source pages' })
      await expect(source.locator('svg')).toHaveCount(0)
      const addFilterBox = await actions.getByRole('button', { name: 'Add filter' }).boundingBox()
      const sourceBox = await source.boundingBox()
      expect(sourceBox?.height).toBe(addFilterBox?.height)

      const header = references.locator('.linked-references-header')
      const onHeaderLine = await references.getByRole('button').evaluateAll(
        (buttons, el) => {
          const line = (el as Element).getBoundingClientRect()
          return buttons.filter((b) => {
            const r = b.getBoundingClientRect()
            return r.bottom > line.top && r.top < line.bottom
          }).length
        },
        await header.elementHandle(),
      )
      expect(onHeaderLine).toBe(1)

      await source.click()
      await page.locator('.source-page-filter-item').first().click()
      // An open sheet hides the page from the accessibility tree, so not by role.
      await expect(actions.locator('.source-page-filter-trigger')).toHaveText('Source pages · 1')
    })

    test("References: each control takes the taps on its own face, not a neighbour's hit area", async ({
      page,
    }) => {
      await (phone ? openPageMobile : openPage)(page, 'Getting Started')
      const references = page.getByTestId('linked-references')
      const controls = [
        references.locator('.linked-references-header button'),
        ...(await references.getByRole('radio').all()),
        references.getByRole('button', { name: 'Add filter', exact: true }),
        references.getByRole('button', { name: 'Source pages' }),
        references.getByRole('combobox', { name: 'Sort by' }),
        references.getByTestId('backlink-sort-direction'),
      ]
      await references
        .getByRole('button', { name: 'Add filter', exact: true })
        .evaluate((el) => el.scrollIntoView({ block: 'center' }))
      for (const control of controls) {
        // The centre and 2 px inside each edge must hit the control itself.
        const misses = await control.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const cx = r.left + r.width / 2
          const cy = r.top + r.height / 2
          const points: [number, number][] = [
            [cx, cy],
            [r.left + 2, cy],
            [r.right - 2, cy],
            [cx, r.top + 2],
            [cx, r.bottom - 2],
          ]
          return points
            .filter(([x, y]) => {
              const hit = document.elementFromPoint(x, y)
              return hit !== el && !el.contains(hit)
            })
            .map(([x, y]) => `${Math.round(x)},${Math.round(y)}`)
        })
        expect(misses, await control.evaluate((el) => el.outerHTML.slice(0, 80))).toEqual([])
      }
    })

    test('Advanced query: Add filter shows the funnel', async ({ page }) => {
      await navigateToView(page, 'Advanced query')
      const addFilter = page.getByRole('button', { name: 'Add filter', exact: true }).first()
      await expect(addFilter.locator('svg.lucide-funnel')).toHaveCount(1)
    })
  })
}
