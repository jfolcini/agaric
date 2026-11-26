/**
 * One view shell (S3, #7040): every view puts its title in the content, as the
 * `FeaturePageHeader` h1 with the view's actions on its row, and the desktop
 * top bar drops its label so the title shows once. A phone's header keeps the
 * name; the in-content h1 stays its heading for assistive tech.
 *
 * Two column widths: 736 px (`max-w-reading`) for the page editor, the journal
 * and Settings, which is centred; 960 px (`max-w-list`) for the lists. Each
 * width has one title edge. Graph stays full width, as a canvas.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  expect,
  expectViewLoaded,
  navigateToView,
  openPage,
  type TopLevelView,
  test,
  VIEW_HEADING,
  waitForBoot,
} from './helpers'

const READING_WIDTH = 736
const LIST_WIDTH = 960

const LIST_VIEWS: TopLevelView[] = [
  'Pages',
  'Search',
  'Tags',
  'Templates',
  'Advanced query',
  'History',
  'Trash',
]

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function box(locator: Locator, label: string): Promise<Box> {
  const b = await locator.boundingBox()
  if (b === null) throw new Error(`${label}: not laid out`)
  return b
}

/** The view's visible in-content title: the `FeaturePageHeader` h1. */
function viewTitle(page: Page): Locator {
  return page.locator('[data-slot="feature-page-header"]:visible')
}

function pane(page: Page): Locator {
  return page.getByTestId('view-transition-wrapper')
}

/** `b` has equal room on both sides inside the view pane. */
async function expectCentred(page: Page, b: Box, label: string): Promise<void> {
  const paneBox = await box(pane(page), 'pane')
  const left = b.x - paneBox.x
  const right = paneBox.x + paneBox.width - (b.x + b.width)
  expect(Math.abs(left - right), `${label} centred`).toBeLessThanOrEqual(1)
}

async function openView(page: Page, view: TopLevelView): Promise<void> {
  await navigateToView(page, view)
  await expectViewLoaded(page, view)
}

/** The header's left edge and width, after checking its h1 names the view and shows. */
async function titleGeometry(page: Page, view: TopLevelView): Promise<Box> {
  const header = viewTitle(page)
  await expect(header).toHaveCount(1)
  const h1 = header.getByRole('heading', { level: 1 })
  await expect(h1).toHaveText(VIEW_HEADING[view])
  expect((await box(h1, `${view} title`)).width, `${view} title shows`).toBeGreaterThan(1)
  return box(header, `${view} header`)
}

test.describe('the view shell at 1440 px @pages @journal @settings @graph @search', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the list views share one 960 px column and one title edge', async ({ page }) => {
    await waitForBoot(page)
    const edges = new Set<number>()
    for (const view of LIST_VIEWS) {
      await openView(page, view)
      const header = await titleGeometry(page, view)
      expect(header.width, `${view} column`).toBe(LIST_WIDTH)
      edges.add(Math.round(header.x))
      await expect(page.getByTestId('header-label'), `${view} top bar`).toBeHidden()
    }
    expect([...edges]).toHaveLength(1)
  })

  test('the journal, a page and Settings share one centred 736 px column', async ({ page }) => {
    await waitForBoot(page)
    await openView(page, 'Journal')
    const journal = await titleGeometry(page, 'Journal')
    expect(journal.width).toBe(READING_WIDTH)
    await expectCentred(page, journal, 'Journal')

    await openView(page, 'Settings')
    const settings = await titleGeometry(page, 'Settings')
    expect(settings.width).toBe(READING_WIDTH)
    await expectCentred(page, settings, 'Settings')
    const panel = await box(
      page.locator('[role="tabpanel"][data-testid^="settings-panel-"]'),
      'panel',
    )
    expect(panel.width, 'Settings panel').toBe(READING_WIDTH)
    expect(panel.x, 'Settings panel edge').toBe(settings.x)
    await expect(page.getByTestId('header-label')).toBeHidden()

    await openPage(page, 'Getting Started')
    const pageHeader = page.locator('[data-testid="view-header-outlet"]:visible .page-header')
    const column = await box(pageHeader, 'page header')
    expect(column.width, 'page column').toBe(READING_WIDTH)
    expect(Math.round(column.x), 'page edge').toBe(Math.round(journal.x))
    expect(Math.round(settings.x), 'Settings title edge').toBe(Math.round(journal.x))
  })

  test('Graph puts its title in the content at the full width', async ({ page }) => {
    await waitForBoot(page)
    await openView(page, 'Graph')
    const header = await titleGeometry(page, 'Graph')
    expect(header.width).toBe((await box(pane(page), 'pane')).width)
    await expect(page.getByTestId('header-label')).toBeHidden()
  })

  test("a view's actions sit on its title row", async ({ page }) => {
    await waitForBoot(page)
    await openView(page, 'Pages')
    const row = viewTitle(page)
    const h1 = await box(row.getByRole('heading', { level: 1 }), 'title')
    const action = row.getByRole('button', { name: 'New page', exact: true })
    await expect(action).toBeVisible()
    const button = await box(action, 'New page')
    expect(Math.abs(h1.y + h1.height / 2 - (button.y + button.height / 2))).toBeLessThanOrEqual(1)
  })
})

// At 1440 px the tab rail exactly fills the room left of a centred column, so
// only a wider window tells a centred Settings from a left-aligned one.
test('Settings stays centred on a wide window @settings', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await waitForBoot(page)
  await openView(page, 'Settings')
  const settings = await titleGeometry(page, 'Settings')
  expect(settings.width).toBe(READING_WIDTH)
  await expectCentred(page, settings, 'Settings')
})

test.describe('the view shell on a phone @mobile @pages @settings @graph @search', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    userAgent: devices['Pixel 7'].userAgent,
    isMobile: true,
    hasTouch: true,
  })

  for (const view of [...LIST_VIEWS, 'Settings', 'Graph'] as TopLevelView[]) {
    test(`${view}'s header keeps the name, its h1 stays for assistive tech`, async ({ page }) => {
      await waitForBoot(page)
      await openView(page, view)
      await expect(page.getByTestId('header-label')).toBeVisible()
      await expect(page.getByTestId('header-label')).toHaveText(VIEW_HEADING[view])
      const h1 = page.locator('[data-slot="feature-page-header-title"]')
      await expect(h1).toHaveText(VIEW_HEADING[view])
      expect((await box(h1, 'h1')).width, 'h1 visually hidden').toBeLessThanOrEqual(1)
      // The hidden title takes no room: what follows it starts its column.
      const room = await page.locator('[data-slot="feature-page-header"]').evaluate((header) => {
        const parent = header.parentElement as HTMLElement
        const next = header.nextElementSibling as HTMLElement
        const top =
          parent.getBoundingClientRect().top + parseFloat(getComputedStyle(parent).paddingTop)
        return next.getBoundingClientRect().top - top
      })
      expect(room, 'room above the content').toBeLessThanOrEqual(0.5)
    })
  }
})
