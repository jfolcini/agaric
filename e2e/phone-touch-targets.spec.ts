/**
 * E2E — phone touch targets (#5930): on a 390 × 844 touch phone every control
 * below takes a tap anywhere in a 44 × 44 box around its centre, and the
 * drawer's nav rows line up with its header controls (#5929). A tap is probed
 * with `elementFromPoint`, so a pseudo-element hit area counts and a
 * neighbour drawn over the control does not.
 */

import { devices, type Locator, type Page } from '@playwright/test'

import {
  activePopover,
  expect,
  ipc,
  navigateToView,
  openMobileSidebar,
  openPageMobile,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

const iPhone13 = devices['iPhone 13']

/**
 * Whether a tap 21 px left, right, above and below the centre reaches `el`:
 * a 44 px box less a pixel, which a neighbour's text may overhang.
 */
async function hits44(el: Locator): Promise<boolean[]> {
  await el.scrollIntoViewIfNeeded()
  return el.evaluate((node) => {
    const r = node.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const d = 21
    return [
      [cx - d, cy],
      [cx + d, cy],
      [cx, cy - d],
      [cx, cy + d],
    ].map(([x, y]) => node.contains(document.elementFromPoint(x ?? 0, y ?? 0)))
  })
}

async function expect44(el: Locator, name: string): Promise<void> {
  expect(await hits44(el), `${name}: left, right, top, bottom of a 44 px box`).toEqual([
    true,
    true,
    true,
    true,
  ])
}

async function left(el: Locator): Promise<number> {
  return Math.round((await el.boundingBox())?.x ?? Number.NaN)
}

test.describe('phone touch targets @mobile', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  test('drawer rows are 44 px and line up with the header controls', async ({ page }) => {
    await waitForBoot(page)
    const sheet = await openMobileSidebar(page)
    const newPage = sheet.getByRole('button', { name: 'New Page', exact: true })
    const rows = [
      newPage,
      ...['Journal', 'Tasks', 'Pages', 'Search', 'Tags'].map((name) =>
        sheet.getByRole('button', { name, exact: true }),
      ),
      sheet.getByTestId('sidebar-bookmarks-toggle'),
    ]
    for (const row of rows) await expect44(row, (await row.textContent()) ?? 'drawer row')

    const gutter = await left(sheet.getByRole('combobox', { name: 'Switch space', exact: true }))
    expect(await left(newPage), 'New Page').toBe(gutter)
    for (const name of ['Journal', 'Tags', 'Sync']) {
      expect(await left(sheet.getByRole('button', { name, exact: true })), name).toBe(gutter)
    }
  })

  test('the Tags and Templates name inputs', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Tags')
    await expect44(page.getByRole('textbox', { name: 'New tag name' }), 'New tag name')
    await navigateToView(page, 'Templates')
    await expect44(page.getByRole('textbox', { name: 'New template name' }), 'New template name')
  })

  test("Advanced Query's NOT toggle", async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Advanced Query')
    const root = page.getByRole('group', { name: 'Filter', exact: true })
    await root.getByRole('button', { name: 'Add filter', exact: true }).click()
    const pop = activePopover(page)
    await pop.getByRole('button', { name: /^State/ }).click()
    await pop.getByRole('checkbox', { name: 'DONE', exact: true }).click()
    await pop.getByRole('button', { name: 'Apply', exact: true }).click()
    const leaf = root.getByTestId('filter-group-leaf')
    await expect(leaf).toHaveCount(1)
    await expect44(leaf.getByRole('button', { name: 'NOT', exact: true }), 'leaf NOT')
  })

  test("References' Collapse group", async ({ page }) => {
    await waitForBoot(page)
    await openPageMobile(page, 'Getting Started')
    const refs = page.getByTestId('linked-references')
    const collapse = refs.getByRole('button', { name: 'Collapse group' }).first()
    await expect44(collapse, 'Collapse group')
    // It stays inside its header row, whose pressed background it sits on.
    expect(await left(collapse)).toBe(
      await left(refs.locator('.linked-references-group-header').first()),
    )
  })

  test("Agenda's status filter chip", async ({ page }) => {
    await waitForBoot(page)
    await page
      .locator('header')
      .first()
      .getByRole('button', { name: /^Journal view mode/ })
      .click()
    await page.getByRole('button', { name: 'Agenda', exact: true }).click()
    // The agenda opens on its default status filter.
    const chip = page
      .getByTestId('agenda-filter-builder')
      .getByRole('button', { name: /^Edit Status: .* filter$/ })
    await expect44(chip, 'status chip')
  })

  test("Settings › Properties' Task cycle help", async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
    await openSettingsTab(page, 'Properties')
    await expect44(page.getByRole('button', { name: 'Task cycle help' }), 'Task cycle help')
  })
})

// #6532 — the journal's day headings and their count chips sit side by side on
// one 20 px row, and the agenda's date chip under its row's title: each reaches
// 44 px as a hit area, so the rows keep their height and a tap on one never
// lands on its neighbour.
test.describe('journal headings and chips on a 360 px touch phone @mobile @journal', () => {
  test.use({
    viewport: { width: 360, height: 780 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  async function chooseMode(page: Page, mode: RegExp): Promise<void> {
    await page.getByRole('button', { name: /^Journal view mode/ }).click()
    await activePopover(page).getByRole('button', { name: mode }).click()
  }

  async function expectSmallBox(el: Locator, name: string): Promise<void> {
    expect((await el.boundingBox())?.height, `${name}: drawn height`).toBeLessThan(30)
  }

  test('week and stream headings, count chips and the agenda date chip', async ({ page }) => {
    // A Wednesday, so the seed's yesterday, today and tomorrow share a week.
    await page.clock.setFixedTime(new Date('2026-10-21T10:00:00'))
    // Mount every day's tree at once instead of on scroll (DaySection).
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitForBoot(page)
    // A reference to today's journal page, for its refs chip.
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: 'See [[00000000000000000000PAGE03]]',
      parentId: '00000000000000000000PAGE01',
      index: null,
      scope: { kind: 'active', space_id: 'SPACE_PERSONAL' },
    })

    await chooseMode(page, /^Week/)
    const today = page.locator('section[id="journal-2026-10-21"]')
    const heading = today.getByRole('button', { name: /^Go to daily view for/ })
    const due = today.getByRole('button', { name: /Due items?, click to view$/ })
    const refs = today.getByRole('button', { name: /references?, click to view$/ })
    // At 360 px this one wraps under the heading.
    const scheduled = today.getByRole('button', { name: /Scheduled items?, click to view$/ })
    for (const [el, name] of [
      [heading, 'week heading'],
      [due, 'due chip'],
      [refs, 'refs chip'],
      [scheduled, 'scheduled chip'],
    ] as const) {
      await expect44(el, name)
      await expectSmallBox(el, name)
    }

    await chooseMode(page, /^Stream/)
    const streamHeading = page.getByRole('button', { name: /^Go to daily view for/ }).first()
    await expect44(streamHeading, 'stream heading')
    await expectSmallBox(streamHeading, 'stream heading')

    await chooseMode(page, /^Agenda/)
    const dateChip = page.getByRole('button', { name: 'Edit date', exact: true }).first()
    await expect44(dateChip, 'agenda date chip')
    await expectSmallBox(dateChip, 'agenda date chip')
  })
})
