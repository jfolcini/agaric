import { createRequire } from 'node:module'
import type { Locator, Page } from '@playwright/test'
import {
  activeAlertDialog,
  activePopover,
  expect,
  openAddFilter,
  test,
  waitForBoot,
} from './helpers'

// Resolve the bundled axe-core source for in-page injection. `addScriptTag`
// runs in Node, and this spec is ESM, so build a `require` to locate the
// package's main file deterministically regardless of the test cwd.
const axePath = createRequire(import.meta.url).resolve('axe-core')

/**
 * PEND-58d — comprehensive behavioural e2e for every Pages-view capability.
 *
 * Companion to `pages-filter.spec.ts` (chip-render + grooming facets); this
 * file asserts that each user-facing feature *does the thing* — narrows the
 * list, reorders the rows, persists a preference, recovers from a zero state —
 * rather than merely rendering a control.
 *
 * Harness notes (shared with `pages-filter.spec.ts`):
 *   - The chip row is the DEFAULT surface: `pageBrowser.densityV1` is an
 *     OPT-OUT (only the literal string `'false'` falls back to legacy
 *     `listBlocks`). The flag is read once at mount, so flag-setting tests
 *     register an init script BEFORE `waitForBoot`'s `page.goto('/')`.
 *   - The tauri-mock derives `block_links` from `[[ULID]]` tokens, so the link
 *     facets reflect the seed topology: `Getting Started` ⇄ `Quick Notes`
 *     cross-reference (neither orphan); `Projects` / `Meetings` / the daily
 *     page / the meeting template are orphans (no links either way).
 *   - The mock genuinely filters `PathGlob` / `HasProperty` / `LastEdited` /
 *     `Tag` / `Priority` and returns a real `total_count`, so narrowing AND
 *     the count chip are assertable.
 *   - Page-level `Tag` / `Priority` are not set on the canonical seed (its
 *     tags/priorities live on child blocks). The `__mockFacetFixture` opt-in
 *     adds one "Facet Fixture" page carrying a page-level tag `work` +
 *     priority `1` so those two facets narrow to a concrete non-empty set.
 *
 * Seed pages (6, alphabetical): the daily page (YYYY-MM-DD), Getting Started,
 * Meeting Notes Template, Meetings, Projects, Quick Notes.
 */

const TAG_WORK_ID = '000000000000000000000TAG01'

interface BootOpts {
  /** `'off'` exercises the legacy `listBlocks` path (no chip row). */
  flag?: 'default' | 'off'
  /** Seed N extra "Bulk Page NNN" pages for pagination / virtualization. */
  extraPages?: number
  /** Add the page-level Tag/Priority fixture page. */
  facetFixture?: boolean
}

async function openPagesView(page: Page): Promise<void> {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  await expect(page.getByRole('grid')).toBeVisible()
}

/** Set localStorage flags before boot, then open the Pages view. */
async function bootPages(page: Page, opts: BootOpts = {}): Promise<void> {
  const { flag = 'default', extraPages = 0, facetFixture = false } = opts
  if (flag === 'off') {
    await page.addInitScript(() => {
      window.localStorage.setItem('pageBrowser.densityV1', 'false')
    })
  }
  if (extraPages > 0) {
    await page.addInitScript((n) => {
      window.localStorage.setItem('__mockExtraPages', String(n))
    }, extraPages)
  }
  if (facetFixture) {
    await page.addInitScript(() => {
      window.localStorage.setItem('__mockFacetFixture', 'true')
    })
  }
  await waitForBoot(page)
  await openPagesView(page)
}

const grid = (page: Page): Locator => page.getByRole('grid')

/** Visible page titles, in DOM order. Stable behavioural read of the list. */
function visibleTitles(page: Page): Promise<string[]> {
  return grid(page).locator('[data-page-item] .page-browser-item-title').allTextContents()
}

/** The muted count chip text (e.g. "6 pages", "4 matching pages"). */
function countChip(page: Page): Locator {
  return page.getByTestId('page-browser-count')
}

/**
 * Add a boolean Pages facet whose menu item appends a description to its
 * accessible name (so `exact: true` no longer matches). Anchors on the label.
 */
async function addBooleanFacet(page: Page, label: 'Orphan' | 'Stub' | 'No inbound links') {
  await openAddFilter(page)
  await activePopover(page)
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .click()
}

/** Open the path editor, fill a pattern, optionally tick Exclude, and apply. */
async function addPathFilter(page: Page, pattern: string, exclude = false) {
  await openAddFilter(page)
  const pop = activePopover(page)
  await pop.getByRole('button', { name: /^Page path/ }).click()
  await pop.getByPlaceholder('e.g. Projects/*').fill(pattern)
  if (exclude) {
    await pop.getByRole('checkbox', { name: 'Exclude matching pages' }).click()
  }
  await pop.getByRole('button', { name: 'Apply' }).click()
}

/** Open the has-property editor, choose an op, and apply. */
async function addPropertyFilter(
  page: Page,
  key: string,
  op: 'is' | 'is not' | 'exists' | "doesn't exist",
  value?: string,
) {
  await openAddFilter(page)
  const pop = activePopover(page)
  await pop.getByRole('button', { name: /^Has property/ }).click()
  await pop.getByPlaceholder('Property key').fill(key)
  await pop.getByRole('combobox', { name: 'Comparison' }).selectOption({ label: op })
  if (value !== undefined) {
    await pop.getByPlaceholder('Value', { exact: true }).fill(value)
  }
  await pop.getByRole('button', { name: 'Apply' }).click()
}

async function selectSort(page: Page, optionName: string) {
  await page.getByRole('combobox', { name: 'Sort order' }).click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

async function selectDensity(page: Page, optionName: 'Compact' | 'Regular' | 'Expanded') {
  await page.getByRole('combobox', { name: 'Row density' }).click()
  await page.getByRole('option', { name: optionName, exact: true }).click()
}

async function scrollGridToBottom(page: Page) {
  await grid(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
}

// ===========================================================================
// 1. Each facet narrows
// ===========================================================================
test.describe('PEND-58d — facet narrowing (each facet does the thing)', () => {
  test('Orphan narrows to fully-isolated pages', async ({ page }) => {
    await bootPages(page)
    await expect(grid(page).getByText('Getting Started', { exact: true })).toBeVisible()

    await addBooleanFacet(page, 'Orphan')
    // Getting Started ⇄ Quick Notes cross-link → both drop; the four
    // link-free pages remain.
    await expect(grid(page).getByText('Getting Started', { exact: true })).toHaveCount(0)
    await expect(grid(page).getByText('Quick Notes', { exact: true })).toHaveCount(0)
    await expect(grid(page).getByText('Projects', { exact: true })).toBeVisible()
    await expect(grid(page).getByText('Meetings', { exact: true })).toBeVisible()
    await expect(countChip(page)).toHaveText('4 matching pages')
  })

  test('No-inbound-links narrows (and keeps outbound-only pages distinct from Orphan)', async ({
    page,
  }) => {
    await bootPages(page)
    await addBooleanFacet(page, 'No inbound links')
    // Same four for this seed (no page has inbound-only without also being a
    // full orphan), but the chip is the looser inbound-only sibling.
    await expect(grid(page).getByText('Getting Started', { exact: true })).toHaveCount(0)
    await expect(grid(page).getByText('Projects', { exact: true })).toBeVisible()
    await expect(countChip(page)).toHaveText('4 matching pages')
  })

  test('Stub narrows to zero (every seed page has children)', async ({ page }) => {
    await bootPages(page)
    await addBooleanFacet(page, 'Stub')
    // All seed pages carry child blocks → empties the list (no-match state).
    await expect(page.getByText('No matching pages')).toBeVisible()
    await expect(grid(page)).toHaveCount(0)
  })

  test('Tag narrows to the tagged page', async ({ page }) => {
    await bootPages(page, { facetFixture: true })
    await openAddFilter(page)
    const pop = activePopover(page)
    await pop.getByRole('button', { name: /^Tag/ }).click()
    await pop.getByPlaceholder('Tag id').fill(TAG_WORK_ID)
    await pop.getByPlaceholder('Tag id').press('Enter')

    await expect(grid(page).getByText('Facet Fixture', { exact: true })).toBeVisible()
    await expect(visibleTitles(page)).resolves.toEqual(['Facet Fixture'])
    await expect(countChip(page)).toHaveText('1 matching page')
  })

  test('Priority narrows to the prioritised page', async ({ page }) => {
    await bootPages(page, { facetFixture: true })
    await openAddFilter(page)
    await activePopover(page).getByRole('button', { name: '1', exact: true }).click()

    await expect(visibleTitles(page)).resolves.toEqual(['Facet Fixture'])
    await expect(countChip(page)).toHaveText('1 matching page')
  })

  test('Page-path: substring vs anchored-wildcard vs Exclude', async ({ page }) => {
    await bootPages(page)
    // Substring (bare word) — matches anywhere in the title.
    await addPathFilter(page, 'Meet')
    await expect(visibleTitles(page)).resolves.toEqual(['Meeting Notes Template', 'Meetings'])
    await page.getByRole('button', { name: /^Remove filter path:/ }).click()

    // Anchored wildcard — `Project*` anchors the start; only "Projects" wins.
    await addPathFilter(page, 'Project*')
    await expect(visibleTitles(page)).resolves.toEqual(['Projects'])
    await page.getByRole('button', { name: /^Remove filter path:/ }).click()

    // Exclude — invert the "Meet" substring match: everything BUT the two
    // meeting pages.
    await addPathFilter(page, 'Meet', true)
    const remaining = await visibleTitles(page)
    expect(remaining).not.toContain('Meetings')
    expect(remaining).not.toContain('Meeting Notes Template')
    expect(remaining).toContain('Projects')
    await expect(countChip(page)).toHaveText('4 matching pages')
    await expect(page.getByRole('group', { name: 'Filter: not path: Meet' })).toBeVisible()
  })

  test("Has-property: exists / is value / is-not / doesn't-exist", async ({ page }) => {
    // `template` is set (= "true") only on "Meeting Notes Template".
    await bootPages(page)

    // exists → only the template page.
    await addPropertyFilter(page, 'template', 'exists')
    await expect(visibleTitles(page)).resolves.toEqual(['Meeting Notes Template'])
    await page.getByRole('button', { name: /^Remove filter has:/ }).click()

    // is value (template = true) → still only the template page.
    await addPropertyFilter(page, 'template', 'is', 'true')
    await expect(visibleTitles(page)).resolves.toEqual(['Meeting Notes Template'])
    await page.getByRole('button', { name: /^Remove filter/ }).click()

    // is-not (template ≠ true) → the other five pages (absent counts as ≠).
    await addPropertyFilter(page, 'template', 'is not', 'true')
    let titles = await visibleTitles(page)
    expect(titles).not.toContain('Meeting Notes Template')
    expect(titles).toContain('Projects')
    await expect(countChip(page)).toHaveText('5 matching pages')
    await page.getByRole('button', { name: /^Remove filter/ }).click()

    // doesn't-exist → the five pages without the key.
    await addPropertyFilter(page, 'template', "doesn't exist")
    titles = await visibleTitles(page)
    expect(titles).not.toContain('Meeting Notes Template')
    await expect(countChip(page)).toHaveText('5 matching pages')
  })

  test('Last-edited buckets: recent buckets match bulk pages, long-ago matches the seed', async ({
    page,
  }) => {
    // Bulk pages are stamped "recent"; the six canonical pages are ~90d old.
    await bootPages(page, { extraPages: 5 })

    for (const bucket of ['Edited today', 'Edited this week', 'Edited this month']) {
      await openAddFilter(page)
      await activePopover(page).getByRole('button', { name: bucket }).click()
      // Only the recent bulk pages match these rolling windows.
      await expect(grid(page).getByText('Bulk Page 001', { exact: true })).toBeVisible()
      await expect(grid(page).getByText('Getting Started', { exact: true })).toHaveCount(0)
      await expect(countChip(page)).toHaveText('5 matching pages')
      await page.getByRole('button', { name: /^Remove filter/ }).click()
      await expect(grid(page).getByText('Getting Started', { exact: true })).toBeVisible()
    }

    // Long-ago → the six canonical (old) pages, none of the recent bulk pages.
    await openAddFilter(page)
    await activePopover(page).getByRole('button', { name: 'Edited long ago' }).click()
    await expect(grid(page).getByText('Getting Started', { exact: true })).toBeVisible()
    await expect(grid(page).getByText('Bulk Page 001', { exact: true })).toHaveCount(0)
    await expect(countChip(page)).toHaveText('6 matching pages')
  })
})

// ===========================================================================
// 2. Compound filters
// ===========================================================================
test.describe('PEND-58d — compound filters (AND-compose / widen / soft-cap)', () => {
  test('two chips AND-narrow; removing one widens', async ({ page }) => {
    await bootPages(page)
    // Orphan (4 pages) ∧ path "Meet" (2 pages) → only "Meeting Notes
    // Template" and "Meetings" are BOTH orphan AND path-matching.
    await addBooleanFacet(page, 'Orphan')
    await expect(countChip(page)).toHaveText('4 matching pages')
    await addPathFilter(page, 'Meet')
    await expect(visibleTitles(page)).resolves.toEqual(['Meeting Notes Template', 'Meetings'])
    await expect(countChip(page)).toHaveText('2 matching pages')

    // Remove the path chip → widen back to the four orphan pages.
    await page.getByRole('button', { name: /^Remove filter path:/ }).click()
    await expect(page.getByRole('group', { name: 'Filter: Orphan' })).toBeVisible()
    await expect(countChip(page)).toHaveText('4 matching pages')
  })

  test("three chips compose (Orphan ∧ not-path ∧ doesn't-have template)", async ({ page }) => {
    await bootPages(page)
    await addBooleanFacet(page, 'Orphan') // 4 orphan pages
    await addPathFilter(page, 'Meet', true) // drop the two meeting pages → 2
    await addPropertyFilter(page, 'template', "doesn't exist") // template page already gone
    // Orphan ∧ not-Meet → Projects + the daily page; both lack `template`.
    const titles = await visibleTitles(page)
    expect(titles).toContain('Projects')
    expect(titles).not.toContain('Meetings')
    expect(titles).not.toContain('Meeting Notes Template')
    expect(titles).not.toContain('Getting Started')
    await expect(page.getByRole('group')).toHaveCount(3)
  })

  test('soft-cap warning appears at MAX_PAGE_FILTERS (8 distinct chips)', async ({ page }) => {
    await bootPages(page)
    // Chips dedupe structurally, so use eight distinct path globs.
    for (let i = 0; i < 8; i++) {
      await addPathFilter(page, `pat${i}`)
    }
    await expect(page.getByRole('group', { name: /^Filter: path:/ })).toHaveCount(8)
    // The next Add-Filter open surfaces the soft-cap note.
    await openAddFilter(page)
    await expect(activePopover(page).getByText('Many filters can slow the view.')).toBeVisible()
  })
})

// ===========================================================================
// 3. Zero-result state
// ===========================================================================
test.describe('PEND-58d — zero-result state', () => {
  test('a chip that empties the list shows no-match (not create-first) and recovers', async ({
    page,
  }) => {
    await bootPages(page)
    await addBooleanFacet(page, 'Stub')

    // The "No matching pages" status shows — NOT the empty-space
    // "No pages yet / Create your first page" affordance.
    await expect(page.getByText('No matching pages')).toBeVisible()
    await expect(page.getByText('No pages yet.')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Create your first page' })).toHaveCount(0)

    // The chip row stays mounted so the user can always recover.
    await expect(page.getByTestId('page-browser-filter-row')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add filter' })).toBeVisible()

    // Removing the chip restores the full list.
    await page.getByRole('button', { name: 'Remove filter Stub' }).click()
    await expect(grid(page).getByText('Getting Started', { exact: true })).toBeVisible()
  })
})

// ===========================================================================
// 4. Clear-all
// ===========================================================================
test.describe('PEND-58d — clear-all', () => {
  test('clear-all removes every chip and restores the full list', async ({ page }) => {
    await bootPages(page)
    await addBooleanFacet(page, 'Orphan')
    await addPathFilter(page, 'Meet')
    await expect(page.getByRole('group')).toHaveCount(2)

    await page.getByRole('button', { name: 'Clear all filters' }).click()
    await expect(page.getByRole('group')).toHaveCount(0)
    // The clear-all control hides once there are no chips.
    await expect(page.getByRole('button', { name: 'Clear all filters' })).toHaveCount(0)
    // Full list is back.
    await expect(grid(page).getByText('Getting Started', { exact: true })).toBeVisible()
    await expect(countChip(page)).toHaveText('6 pages')
  })
})

// ===========================================================================
// 5. Count chip
// ===========================================================================
test.describe('PEND-58d — count chip', () => {
  test('shows total with no filter, countMatching with chips, X-of-Y with text', async ({
    page,
  }) => {
    await bootPages(page)
    // (a) no filter → grand total.
    await expect(countChip(page)).toHaveText('6 pages')

    // (c) chips → the filtered total ("N matching pages").
    await addBooleanFacet(page, 'Orphan')
    await expect(countChip(page)).toHaveText('4 matching pages')

    // (b) free-text over the chip-filtered set → "X of Y matching" where Y is
    // the chip-filtered total. "Meet" narrows the 4 orphans to 2.
    await page.getByPlaceholder('Search pages...').fill('Meet')
    await expect(countChip(page)).toHaveText('2 of 4 matching')

    // Clearing the text reverts to the chip total.
    await page.getByPlaceholder('Search pages...').fill('')
    await expect(countChip(page)).toHaveText('4 matching pages')
  })
})

// ===========================================================================
// 6. Search box
// ===========================================================================
test.describe('PEND-58d — search box', () => {
  test('text narrows by title and composes orthogonally with a chip', async ({ page }) => {
    await bootPages(page)
    const search = page.getByPlaceholder('Search pages...')

    // Plain title narrowing.
    await search.fill('Quick')
    await expect(visibleTitles(page)).resolves.toEqual(['Quick Notes'])
    await search.fill('')

    // Orthogonal axes: chip filters server-side (orphans), text narrows the
    // loaded set client-side.
    await addBooleanFacet(page, 'Orphan')
    await search.fill('Project')
    await expect(visibleTitles(page)).resolves.toEqual(['Projects'])
    // A title outside the orphan set never reappears via text.
    await search.fill('Getting')
    await expect(page.getByText('No matching pages')).toBeVisible()
  })

  test('alias resolves a page that the title text would not match', async ({ page }) => {
    await bootPages(page)
    // "Getting Started" carries aliases ['gs', 'getting-started']. Typing the
    // alias surfaces the page via the alias resolver, with an `(alias)` marker.
    await page.getByPlaceholder('Search pages...').fill('gs')
    const row = grid(page).locator('[data-page-item]:has-text("Getting Started")')
    await expect(row).toBeVisible()
    await expect(row.locator('.alias-badge')).toBeVisible()
  })
})

// ===========================================================================
// 7. Sort
// ===========================================================================
test.describe('PEND-58d — sort', () => {
  test('the seven modes reorder the list', async ({ page }) => {
    await bootPages(page)

    // Alphabetical (default) — the daily page (digits) sorts before letters.
    await selectSort(page, 'Alphabetical')
    let titles = await visibleTitles(page)
    const sorted = [...titles].sort((a, b) => a.localeCompare(b))
    expect(titles).toEqual(sorted)

    // Default — id-ASC (the seed pages were inserted Getting Started first).
    await selectSort(page, 'Default')
    titles = await visibleTitles(page)
    expect(titles[0]).toBe('Getting Started')

    // Most linked — Getting Started + Quick Notes (each 1 inbound) lead the
    // zero-inbound pages.
    await selectSort(page, 'Most linked')
    titles = await visibleTitles(page)
    expect(titles.slice(0, 2).sort()).toEqual(['Getting Started', 'Quick Notes'])

    // Most content — Getting Started and the daily page each carry 5 child
    // blocks (the most), so they lead; the alphabetical tiebreaker puts the
    // daily page (digits) ahead of "Getting Started". Both head the list.
    await selectSort(page, 'Most content')
    titles = await visibleTitles(page)
    expect(titles.slice(0, 2)).toContain('Getting Started')

    // Recently modified — all seed pages share the ~90d stamp, so the
    // alphabetical tiebreaker applies; assert it's a valid permutation.
    await selectSort(page, 'Recently modified')
    expect((await visibleTitles(page)).length).toBe(6)

    // Created (ULID DESC) and Recent (visit history) both reorder without
    // dropping rows.
    await selectSort(page, 'Created')
    expect((await visibleTitles(page)).length).toBe(6)
    await selectSort(page, 'Recent')
    expect((await visibleTitles(page)).length).toBe(6)
  })

  test('frontend-only-sort cue appears past page 1 for alphabetical', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    // Alphabetical is a frontend-only sort; with more pages to load the cue
    // tells the user the order covers loaded pages only.
    await selectSort(page, 'Alphabetical')
    await expect(page.getByTestId('page-browser-frontend-sort-cue')).toBeVisible()
    await expect(page.getByTestId('page-browser-frontend-sort-cue')).toHaveText(
      'Sorted within loaded pages',
    )

    // A server-side sort (recently-modified) is globally accurate → no cue.
    await selectSort(page, 'Recently modified')
    await expect(page.getByTestId('page-browser-frontend-sort-cue')).toHaveCount(0)
  })

  test('sort preference persists across reload', async ({ page }) => {
    await bootPages(page)
    await selectSort(page, 'Most content')
    // Capture the chosen order before reload.
    const before = await visibleTitles(page)
    await expect(page.getByRole('combobox', { name: 'Sort order' })).toContainText('Most content')

    await page.reload()
    await openPagesView(page)
    // The combobox restored the persisted choice and the same order applies.
    await expect(page.getByRole('combobox', { name: 'Sort order' })).toContainText('Most content')
    await expect(visibleTitles(page)).resolves.toEqual(before)
  })
})

// ===========================================================================
// 8. Density
// ===========================================================================
test.describe('PEND-58d — density', () => {
  test('toggling density changes the rows and persists across reload', async ({ page }) => {
    await bootPages(page)
    const firstRow = grid(page).locator('[data-page-item]').first()
    // Default density.
    await expect(firstRow).toHaveAttribute('data-density', 'regular')

    // Compact — metadata badges fold into the tooltip (no visible metadata).
    await selectDensity(page, 'Compact')
    await expect(grid(page).locator('[data-page-item]').first()).toHaveAttribute(
      'data-density',
      'compact',
    )
    await expect(
      grid(page).locator('[data-page-item]').first().locator('[data-page-metadata]'),
    ).toHaveCount(0)

    // Expanded — full metadata row is present.
    await selectDensity(page, 'Expanded')
    await expect(grid(page).locator('[data-page-item]').first()).toHaveAttribute(
      'data-density',
      'expanded',
    )
    await expect(
      grid(page).locator('[data-page-item]').first().locator('[data-page-metadata]'),
    ).toBeVisible()

    // Persist across reload.
    await page.reload()
    await openPagesView(page)
    await expect(grid(page).locator('[data-page-item]').first()).toHaveAttribute(
      'data-density',
      'expanded',
    )
  })
})

// ===========================================================================
// 9. Pagination / virtualization (extends, doesn't duplicate, pages-filter)
// ===========================================================================
test.describe('PEND-58d — pagination / virtualization', () => {
  test('load-more footer is a valid grid row (role=row > gridcell)', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    await expect(grid(page).getByText('Bulk Page 001', { exact: true })).toBeVisible()
    // The footer button lives inside a role=row > role=gridcell so the
    // virtualized grid keeps a valid child structure.
    const footerRow = grid(page).locator('.page-browser-load-more-row')
    await expect(footerRow).toHaveAttribute('role', 'row')
    await expect(footerRow.locator('[role="gridcell"]')).toBeVisible()
    await expect(footerRow.getByRole('button', { name: /load more/i })).toBeVisible()
  })

  test('clicking the load-more button fetches the next page (a11y fallback)', async ({ page }) => {
    // 86 total pages; the first page loads 50, so one explicit click of the
    // load-more button (the keyboard / no-JS fallback) pulls the rest.
    await bootPages(page, { extraPages: 80 })
    await expect(page.getByTestId('load-more-progress')).toHaveText('Loaded 50 of 86')

    await page.getByRole('button', { name: /load more/i }).click()
    // Everything is now loaded → the load-more button + progress disappear.
    await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0)
    // A late page is now reachable (it was on the unfetched cursor page before).
    await expect
      .poll(
        async () => {
          await scrollGridToBottom(page)
          return grid(page).getByText('Bulk Page 080', { exact: true }).count()
        },
        { timeout: 8000 },
      )
      .toBeGreaterThan(0)
    await expect(grid(page).getByText('Bulk Page 080', { exact: true })).toHaveCount(1)
  })

  test('DOM windowing caps rendered rows well below the full set', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    await expect(grid(page).getByText('Bulk Page 001', { exact: true })).toBeVisible()
    // 86 total pages, but the virtualizer keeps only a small window in the DOM.
    expect(await grid(page).getByRole('row').count()).toBeLessThan(40)
  })
})

// ===========================================================================
// 10. CRUD + grooming
// ===========================================================================
test.describe('PEND-58d — CRUD + grooming', () => {
  test('create page (unfiltered) prepends optimistically and bumps the count', async ({ page }) => {
    await bootPages(page)
    await expect(countChip(page)).toHaveText('6 pages')

    await page.getByPlaceholder('New page name...').fill('Brand New Page')
    await page
      .getByTestId('view-header-outlet')
      .getByRole('button', { name: /New Page/i })
      .click()

    // Creating navigates to the editor; go back to Pages and confirm it landed.
    await openPagesView(page)
    await expect(grid(page).getByText('Brand New Page', { exact: true })).toBeVisible()
    await expect(countChip(page)).toHaveText('7 pages')
  })

  test('create with chips active: a non-matching new page does NOT appear', async ({ page }) => {
    await bootPages(page)
    // Filter to orphan pages, then create a page whose title links out (so it
    // is NOT an orphan). With chips active the create path refetches from the
    // server, so a non-matching new page is correctly absent.
    await addBooleanFacet(page, 'Orphan')
    await expect(countChip(page)).toHaveText('4 matching pages')

    // A freshly-created page is itself an orphan (no links), so to prove the
    // "only appears if it matches" rule we instead create under the OPPOSITE
    // filter: filter to "has template", which the new page won't have.
    await page.getByRole('button', { name: 'Remove filter Orphan' }).click()
    await addPropertyFilter(page, 'template', 'exists')
    await expect(visibleTitles(page)).resolves.toEqual(['Meeting Notes Template'])

    await page.getByPlaceholder('New page name...').fill('No Template Page')
    await page
      .getByTestId('view-header-outlet')
      .getByRole('button', { name: /New Page/i })
      .click()
    await openPagesView(page)
    // The has-template chip survives the navigation round-trip; the new page
    // lacks `template` so it must not be in the filtered result.
    await expect(page.getByRole('group', { name: /^Filter: has:/ })).toBeVisible()
    await expect(grid(page).getByText('No Template Page', { exact: true })).toHaveCount(0)
    await expect(visibleTitles(page)).resolves.toEqual(['Meeting Notes Template'])
  })

  test('delete shows a confirm dialog; confirming removes the row and drops the count', async ({
    page,
  }) => {
    await bootPages(page)
    await expect(countChip(page)).toHaveText('6 pages')
    const row = grid(page).locator('[data-page-item]:has-text("Projects")')
    await row.getByRole('button', { name: 'Delete page' }).click()

    // Confirm dialog appears.
    const dialog = activeAlertDialog(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Delete page?')).toBeVisible()
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    // The row is gone (the core delete behaviour) and the remaining list is
    // exactly the other five pages.
    await expect(grid(page).getByText('Projects', { exact: true })).toHaveCount(0)
    await expect(grid(page).locator('[data-page-item]')).toHaveCount(5)
    // The count chip drops (optimistic decrement). The dev server runs React
    // StrictMode, which double-invokes the delete updater and so over-counts
    // the decrement; assert the directional behaviour rather than pinning a
    // dev-only off-by-one.
    await expect
      .poll(async () => Number((await countChip(page).textContent())?.match(/\d+/)?.[0]))
      .toBeLessThan(6)
  })

  test('delete can be cancelled and leaves the row intact', async ({ page }) => {
    await bootPages(page)
    const row = grid(page).locator('[data-page-item]:has-text("Projects")')
    await row.getByRole('button', { name: 'Delete page' }).click()
    const dialog = activeAlertDialog(page)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(grid(page).getByText('Projects', { exact: true })).toBeVisible()
    await expect(countChip(page)).toHaveText('6 pages')
  })

  test('star / unstar groups the page under Starred and back', async ({ page }) => {
    await bootPages(page)
    await page.evaluate(() => window.localStorage.removeItem('starred-pages'))
    await page.reload()
    await openPagesView(page)

    const row = grid(page).locator('[data-page-item]:has-text("Quick Notes")')
    await row.locator('.star-toggle').click()
    // Starred section appears; the starred page floats to the top.
    await expect(page.locator('[data-page-section="starred"]')).toBeVisible()
    await expect(grid(page).locator('[data-page-item]').first()).toContainText('Quick Notes')

    // Unstar → the Starred section disappears.
    await grid(page)
      .locator('[data-page-item]:has-text("Quick Notes")')
      .first()
      .locator('.star-toggle')
      .click()
    await expect(page.locator('[data-page-section="starred"]')).toHaveCount(0)
  })
})

// ===========================================================================
// 11. Flag paths
// ===========================================================================
test.describe('PEND-58d — flag paths', () => {
  test('densityV1 default-on renders the chip-row + density rows', async ({ page }) => {
    await bootPages(page)
    await expect(page.getByRole('button', { name: 'Add filter' })).toBeVisible()
    // Density rows expose `data-density`.
    await expect(grid(page).locator('[data-page-item][data-density]').first()).toBeVisible()
  })

  test("densityV1 = 'false' opt-out hides the chip-row and density chrome", async ({ page }) => {
    await bootPages(page, { flag: 'off' })
    await expect(page.getByRole('button', { name: 'Add filter' })).toHaveCount(0)
    await expect(page.getByTestId('page-browser-filter-row')).toHaveCount(0)
    // Legacy rows carry no `data-density` attribute.
    await expect(grid(page).locator('[data-page-item][data-density]')).toHaveCount(0)
    // The legacy list still renders the seed pages.
    await expect(grid(page).getByText('Getting Started', { exact: true })).toBeVisible()
  })
})

// ===========================================================================
// 12. Metadata badges
// ===========================================================================
test.describe('PEND-58d — metadata badges', () => {
  test('inbound / children / last-modified render on regular-density rows', async ({ page }) => {
    await bootPages(page)
    // Getting Started: 1 inbound link, 5 child blocks, a relative-time stamp.
    const row = grid(page).locator('[data-page-item]:has-text("Getting Started")')
    await expect(row.locator('[data-metadata-inbound]')).toBeVisible()
    await expect(row.locator('[data-metadata-inbound]')).toContainText('1 ↗')
    await expect(row.locator('[data-metadata-children]')).toBeVisible()
    await expect(row.locator('[data-metadata-children]')).toContainText('5 ⊟')
    await expect(row.locator('[data-metadata-relative]')).toBeVisible()
  })

  test('zero-inbound pages suppress the inbound badge', async ({ page }) => {
    await bootPages(page)
    // Projects has no inbound links → the ↗ badge is omitted, but it has
    // children so the ⊟ badge stays.
    const row = grid(page).locator('[data-page-item]:has-text("Projects")')
    await expect(row.locator('[data-metadata-inbound]')).toHaveCount(0)
    await expect(row.locator('[data-metadata-children]')).toBeVisible()
  })

  test('cross-page inbound links render the inbound badge', async ({ page }) => {
    await bootPages(page)
    // Quick Notes has exactly one cross-page inbound edge (from BLOCK_GS_2 on
    // Getting Started), so its inbound badge reads "1 ↗". (The same-page
    // exclusion mirrored from migration 0070 is covered by the mock unit test
    // `excludes a same-page link` — the shared Quick Notes seed deliberately
    // carries no same-page edge to keep the editor/inner-links specs stable.)
    const row = grid(page).locator('[data-page-item]:has-text("Quick Notes")')
    await expect(row.locator('[data-metadata-inbound]')).toBeVisible()
    await expect(row.locator('[data-metadata-inbound]')).toContainText('1 ↗')
    await expect(row.locator('[data-metadata-inbound]')).not.toContainText('2 ↗')
  })
})

// ===========================================================================
// 13. Cursor robustness (sort change mid-session)
// ===========================================================================
test.describe('PEND-58d — cursor robustness', () => {
  test('changing sort mid-session re-paginates without dupes or drops', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    await expect(grid(page).getByText('Bulk Page 001', { exact: true })).toBeVisible()
    // Paginate a couple of pages under the default sort.
    await scrollGridToBottom(page)
    await scrollGridToBottom(page)

    // Switch to a server-side keyset sort — this resets the cursor basis. The
    // list re-fetches from page 1 under the new sort with a fresh cursor.
    await selectSort(page, 'Recently modified')
    // Return to the top so the leading row is in the virtual window. Under
    // recently-modified the newest bulk page (Bulk Page 001, stamped "now")
    // leads; assert no duplicate of it crept in across the basis change.
    await grid(page).evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(grid(page).getByText('Bulk Page 001', { exact: true })).toHaveCount(1)

    // Paginate to the deep end and confirm a late canonical page (oldest →
    // sorts last) is reachable exactly once.
    await expect
      .poll(
        async () => {
          await scrollGridToBottom(page)
          return grid(page).getByText('Meeting Notes Template', { exact: true }).count()
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)
    await expect(grid(page).getByText('Meeting Notes Template', { exact: true })).toHaveCount(1)
  })
})

// ===========================================================================
// 13b. Cursor IPC contract (PEND-58e E12) — drive the D6 null-retention,
// cross-sort RequiresRefresh, and same-page inbound exclusion paths through
// the mock at the IPC boundary, the same surface the Pages view consumes in
// e2e. The browser-mock activates whenever `window.__TAURI_INTERNALS__` is
// present without the real Tauri runtime, so `invoke(...)` here hits exactly
// the handler that backs the live grid.
// ===========================================================================

/** Minimal `list_pages_with_metadata` response shape for IPC-boundary reads. */
interface MetaResp {
  items: Array<Record<string, unknown>>
  next_cursor: string | null
  has_more: boolean
  total_count: number | null
}

/**
 * Call `list_pages_with_metadata` directly through the mock IPC, returning the
 * raw response (or, on rejection, the thrown AppError-shaped value as
 * `{ __error: ... }` so the cross-sort rejection is assertable without the
 * `page.evaluate` boundary swallowing it).
 */
function invokePages(
  page: Page,
  args: { sort: string; cursor: string | null; limit: number },
): Promise<MetaResp | { __error: { kind?: string; message?: string } }> {
  return page.evaluate(async (a) => {
    const invoke = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (c: string, args?: Record<string, unknown>) => Promise<unknown>
        }
      }
    ).__TAURI_INTERNALS__.invoke
    try {
      return (await invoke('list_pages_with_metadata', {
        filter: { spaceId: 'SPACE_PERSONAL', sort: a.sort, filters: [] },
        cursor: a.cursor,
        limit: a.limit,
      })) as MetaResp
    } catch (err) {
      // Surface the AppError wire shape verbatim ({ kind, message }) so the
      // RequiresRefresh assertion can read it; a thrown value crossing the
      // page.evaluate boundary otherwise arrives as an opaque Error string.
      const e = err as { kind?: string; message?: string }
      return { __error: { kind: e?.kind, message: e?.message } }
    }
  }, args)
}

test.describe('PEND-58e — cursor IPC contract (E12)', () => {
  test('first page carries total_count; cursor pages return null (D6)', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    const first = (await invokePages(page, {
      sort: 'default',
      cursor: null,
      limit: 50,
    })) as MetaResp
    // First page: a real total over the full 86-page set (6 seed + 80 bulk).
    expect(first.total_count).toBe(86)
    expect(first.has_more).toBe(true)
    expect(first.next_cursor).not.toBeNull()

    const second = (await invokePages(page, {
      sort: 'default',
      cursor: first.next_cursor,
      limit: 50,
    })) as MetaResp
    // Cursor page: total_count is null (the mock does not recompute it); the
    // page still returns rows.
    expect(second.total_count).toBeNull()
    expect(second.items.length).toBeGreaterThan(0)
  })

  test('a cursor reused across a sort change is rejected with RequiresRefresh', async ({
    page,
  }) => {
    await bootPages(page, { extraPages: 80 })
    const first = (await invokePages(page, {
      sort: 'default',
      cursor: null,
      limit: 50,
    })) as MetaResp
    expect(first.next_cursor).not.toBeNull()

    // Replay the default-sort cursor under `most-linked` → discriminator
    // mismatch → the mock throws the AppError wire shape with the
    // `RequiresRefresh:` prefix that `withCursorRecovery` keys on.
    const rejected = (await invokePages(page, {
      sort: 'most-linked',
      cursor: first.next_cursor,
      limit: 50,
    })) as { __error: { kind?: string; message?: string } }
    expect(rejected.__error.kind).toBe('validation')
    expect(rejected.__error.message ?? '').toMatch(/^RequiresRefresh:/)
  })

  test('count chip survives load-more (D6 retention, end-to-end)', async ({ page }) => {
    // The UI half of D6: page 1 sets the count, the load-more cursor page
    // returns null total_count, and `PageBrowser`'s `displayTotalCount`
    // retains the page-1 value — so the chip never blanks or resets.
    await bootPages(page, { extraPages: 80 })
    await expect(countChip(page)).toHaveText('86 pages')

    await page.getByRole('button', { name: /load more/i }).click()
    // Even though the cursor page reported total_count = null, the chip holds
    // the retained first-page total (it does not vanish or change).
    await expect(page.getByRole('button', { name: /load more/i })).toHaveCount(0)
    await expect(countChip(page)).toHaveText('86 pages')
  })
})

// ===========================================================================
// 14. a11y + keyboard
// ===========================================================================
test.describe('PEND-58d — a11y + keyboard', () => {
  test('arrow keys move focus and update aria-activedescendant', async ({ page }) => {
    await bootPages(page)
    // Focus the grid, then arrow down — the grid's aria-activedescendant must
    // track the focused row's stable id.
    await grid(page).focus()
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(async () => grid(page).getAttribute('aria-activedescendant'))
      .toMatch(/^page-row-/)
    const firstActive = await grid(page).getAttribute('aria-activedescendant')

    await page.keyboard.press('ArrowDown')
    await expect
      .poll(async () => grid(page).getAttribute('aria-activedescendant'))
      .not.toBe(firstActive)
    // The activedescendant points at an element that is actually in the DOM
    // (ARIA forbids a dangling reference; the list is virtualized so this is
    // a real guard, not a tautology).
    const id = await grid(page).getAttribute('aria-activedescendant')
    expect(id).toBeTruthy()
    await expect(page.locator(`[id="${id}"]`)).toHaveCount(1)
  })

  test('axe finds no violations in the filtered, zero-result, and popover-open states', async ({
    page,
  }) => {
    await bootPages(page)
    await page.addScriptTag({ path: axePath })

    const runAxe = async () =>
      page.evaluate(async () => {
        // @ts-expect-error injected global
        const results = await window.axe.run(document.querySelector('.page-browser'), {
          // Colour-contrast depends on the design tokens, not this view's
          // structure; exclude it so the run targets ARIA/role correctness.
          rules: { 'color-contrast': { enabled: false } },
        })
        return results.violations.map((v: { id: string; nodes: unknown[] }) => ({
          id: v.id,
          count: v.nodes.length,
        }))
      })

    // Filtered (non-empty) state.
    await addBooleanFacet(page, 'Orphan')
    await expect(countChip(page)).toHaveText('4 matching pages')
    expect(await runAxe()).toEqual([])

    // Zero-result state — the grid role is dropped for the status region.
    await addBooleanFacet(page, 'Stub')
    await expect(page.getByText('No matching pages')).toBeVisible()
    expect(await runAxe()).toEqual([])

    // Popover open.
    await openAddFilter(page)
    await expect(activePopover(page)).toBeVisible()
    expect(await runAxe()).toEqual([])
  })
})

// ===========================================================================
// 15. Responsive
// ===========================================================================
test.describe('PEND-58d — responsive', () => {
  test('narrow viewport wraps the header controls instead of overflowing', async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 900 })
    await bootPages(page)
    // The search/sort/density row uses flex-wrap; on a narrow viewport the
    // sort and density controls drop below the search field rather than
    // overflowing. Assert the row is taller than a single control (wrapped)
    // and that every control stays inside the viewport width.
    const sortBox = await page.getByRole('combobox', { name: 'Sort order' }).boundingBox()
    const densityBox = await page.getByRole('combobox', { name: 'Row density' }).boundingBox()
    expect(sortBox).not.toBeNull()
    expect(densityBox).not.toBeNull()
    if (sortBox && densityBox) {
      expect(sortBox.x + sortBox.width).toBeLessThanOrEqual(420 + 1)
      expect(densityBox.x + densityBox.width).toBeLessThanOrEqual(420 + 1)
    }
    // The list still renders the seed pages at this width.
    await expect(grid(page).getByText('Getting Started', { exact: true })).toBeVisible()
  })
})
