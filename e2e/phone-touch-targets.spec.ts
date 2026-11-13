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

// #6532 — a tag chip on its own row's line (the Tags browser, agenda and task
// rows) reaches 44 px tall as a hit area, so the row keeps its height; side by
// side, chips grow only vertically, so a tap between two lands on neither. A
// chip in block text keeps its drawn size: there the area would take taps and
// caret placement from the lines above and below.
test.describe('tag chips on the rows of a 360 px touch phone @mobile @journal @pages', () => {
  test.use({
    viewport: { width: 360, height: 780 },
    hasTouch: iPhone13.hasTouch,
    isMobile: iPhone13.isMobile,
    deviceScaleFactor: iPhone13.deviceScaleFactor,
    userAgent: iPhone13.userAgent,
  })

  const BUY_GROCERIES = '0000000000000000000BLOCK10'
  const TRY_TAGGING = '0000000000000000000BLOCK04'

  /** Whether a tap 21 px above and below the centre of `el` reaches it. */
  async function hitsAboveBelow(el: Locator): Promise<boolean[]> {
    const [, , top, bottom] = await hits44(el)
    return [top ?? false, bottom ?? false]
  }

  async function expectDrawnUnder30(el: Locator, name: string): Promise<void> {
    expect((await el.boundingBox())?.height, `${name}: drawn height`).toBeLessThan(30)
  }

  /** `row`'s height, and its height once `el` loses `hook`: the hit area adds none. */
  async function rowHeights(row: Locator, el: Locator, hook: string): Promise<number[]> {
    const withHook = (await row.boundingBox())?.height ?? Number.NaN
    await el.evaluate((node, cls) => node.classList.remove(cls), hook)
    return [withHook, (await row.boundingBox())?.height ?? Number.NaN]
  }

  test('the Tags browser chip', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Tags')
    const chip = page.getByTestId('tag-item-work')
    await expect44(chip, 'Tags browser chip')
    await expectDrawnUnder30(chip, 'Tags browser chip')
    const [height, without] = await rowHeights(
      page.getByRole('listitem').filter({ has: chip }),
      chip,
      'touch-hit-area',
    )
    expect(height, 'row height').toBe(without)
  })

  test("an agenda row's chips, and not a block's", async ({ page }) => {
    await waitForBoot(page)
    // One-letter names, so both chips are narrower than 44 px. Created in the
    // Tags view, which tells the chips their names.
    await navigateToView(page, 'Tags')
    const nameInput = page.getByRole('textbox', { name: 'New tag name' })
    for (const name of ['a', 'b']) {
      await nameInput.fill(name)
      await nameInput.press('Enter')
      await expect(page.getByTestId(`tag-item-${name}`)).toBeVisible()
    }
    const tags = await ipc<Array<{ tag_id: string; name: string }>>(
      page,
      'list_all_tags_in_space',
      { scope: { kind: 'active', space_id: 'SPACE_PERSONAL' } },
    )
    const idOf = (name: string) => tags.find((tag) => tag.name === name)?.tag_id
    await ipc(page, 'edit_block', {
      blockId: BUY_GROCERIES,
      toText: `Buy groceries #[${idOf('a')}] #[${idOf('b')}]`,
    })

    await navigateToView(page, 'Tasks')
    const row = page.getByTestId('agenda-results-item').filter({ hasText: 'Buy groceries' })
    const chipA = row.getByTestId('tag-ref-chip').filter({ hasText: /^a$/ })
    const chipB = row.getByTestId('tag-ref-chip').filter({ hasText: /^b$/ })
    for (const [chip, name] of [
      [chipA, 'chip a'],
      [chipB, 'chip b'],
    ] as const) {
      expect(await hitsAboveBelow(chip), `${name}: top, bottom of a 44 px box`).toEqual([
        true,
        true,
      ])
      await expectDrawnUnder30(chip, name)
    }
    // Just past each chip and midway between them, at their middle.
    const between = await chipA.evaluate(
      (a, b) => {
        const l = a.getBoundingClientRect()
        const r = (b as Element).getBoundingClientRect()
        const y = l.top + l.height / 2
        return [l.right + 1, (l.right + r.left) / 2, r.left - 1].map((x) => {
          const hit = document.elementFromPoint(x, y)
          if (a.contains(hit)) return 'chip a'
          if ((b as Element).contains(hit)) return 'chip b'
          return a.closest('li')?.contains(hit) ? 'row' : String(hit?.tagName)
        })
      },
      await chipB.elementHandle(),
    )
    expect(between, 'taps between the chips').toEqual(['row', 'row', 'row'])
    const [height, without] = await rowHeights(row, row.locator('.tag-chip-row'), 'tag-chip-row')
    expect(height, 'row height').toBe(without)

    await openPageMobile(page, 'Getting Started')
    const inText = page
      .locator(`[data-block-id="${TRY_TAGGING}"]`)
      .getByTestId('tag-ref-chip')
      .filter({ hasText: 'work' })
    expect(await hitsAboveBelow(inText), 'chip in block text: top, bottom').toEqual([false, false])
  })
})
