import { activePopover, expect, openAddFilter, test, waitForBoot } from './helpers'

/**
 * E2E coverage for PEND-58 — Pages-view compound-filter chip-row.
 *
 * The chip-row is the Pages experience: every page row renders via the
 * metadata-rich `list_pages_with_metadata` path with the compound-filter
 * chip-row above it.
 *
 * The tauri-mock (`src/lib/tauri-mock/handlers.ts`) derives `block_links`
 * edges from `[[ULID]]` tokens in seed content, so the link facets are
 * faithful here:
 *   - `Getting Started` ⇄ `Quick Notes` cross-reference each other — both
 *     have inbound + outbound links, so neither is an orphan / no-inbound.
 *   - `Projects`, `Meetings`, `Daily`, the meeting template have no links in
 *     either direction — they ARE orphans / no-inbound.
 * Every seeded page has child blocks, so `Stub` (childBlockCount === 0)
 * narrows the list to zero — exercising the "chip row stays reachable at zero
 * results" path.
 */

async function openPagesView(page: import('@playwright/test').Page): Promise<void> {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  await expect(page.getByRole('grid')).toBeVisible()
}

/**
 * The boolean Pages facets (`Orphan` / `Stub` / `No inbound links`) render
 * their menu-item label AND a muted description inside the SAME `<button>`,
 * so the button's accessible name is `"<Label><Description>"`. A bare
 * `{ name, exact: true }` therefore no longer matches — anchor the name with
 * a start-of-string regex so the description tail is ignored while the match
 * stays unambiguous (the three labels share no common prefix).
 */
async function addBooleanFacet(
  page: import('@playwright/test').Page,
  label: 'Orphan' | 'Stub' | 'No inbound links',
): Promise<void> {
  await openAddFilter(page)
  await activePopover(page)
    .getByRole('button', { name: new RegExp(`^${label}`) })
    .click()
}

interface BootOpts {
  /** Seed N extra "Bulk Page NNN" pages for pagination / virtualization. */
  extraPages?: number
}

/** Set localStorage state before boot, then open the Pages view. */
async function bootPages(
  page: import('@playwright/test').Page,
  opts: BootOpts = {},
): Promise<void> {
  const { extraPages = 0 } = opts
  if (extraPages > 0) {
    await page.addInitScript((n) => {
      window.localStorage.setItem('__mockExtraPages', String(n))
    }, extraPages)
  }
  await waitForBoot(page)
  await openPagesView(page)
}

/** Scroll the virtualized grid viewport to the bottom (triggers load-more). */
async function scrollGridToBottom(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('grid').evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
}

test.describe('PEND-58 — Pages compound-filter chip-row', () => {
  test('renders the chip row', async ({ page }) => {
    await bootPages(page)
    await expect(page.getByRole('button', { name: 'Add filter' })).toBeVisible()
    await expect(page.getByTestId('page-browser-filter-row')).toBeVisible()
  })

  test('Add-Filter popover offers the shared and Pages-only facets', async ({ page }) => {
    await bootPages(page)
    await openAddFilter(page)
    const pop = activePopover(page)
    await expect(pop).toBeVisible()

    // Category headings.
    await expect(pop.getByText('Filters', { exact: true })).toBeVisible()
    await expect(pop.getByText('Pages', { exact: true })).toBeVisible()

    // Shared value-facets — these menu items carry only their label, so an
    // exact accessible-name match is correct.
    for (const facet of ['Tag', 'Page path', 'Has property']) {
      // PEND-58e E19 added a muted description inside each value-facet menu
      // item (matching the boolean facets below), so the accessible name is
      // now `<label> <description>` — anchor on the label prefix.
      await expect(pop.getByRole('button', { name: new RegExp(`^${facet}`) })).toBeVisible()
    }
    // Pages-only boolean facets — each menu item appends a muted description
    // to its accessible name, so anchor on the label prefix instead.
    for (const facet of ['Orphan', 'Stub', 'No inbound links']) {
      await expect(pop.getByRole('button', { name: new RegExp(`^${facet}`) })).toBeVisible()
    }
    // Last-edited buckets + Priority quick-picks render as inline buttons.
    await expect(pop.getByRole('button', { name: 'Edited today' })).toBeVisible()
    await expect(pop.getByText('Priority', { exact: true })).toBeVisible()
    await expect(pop.getByRole('button', { name: '1', exact: true })).toBeVisible()

    // Search-only primitives are NEVER offered on the Pages surface.
    await expect(pop.getByText('Regex', { exact: true })).toHaveCount(0)
    await expect(pop.getByText('Whole word', { exact: true })).toHaveCount(0)
  })

  test('No-inbound-links facet narrows to orphan pages and restores on remove', async ({
    page,
  }) => {
    await bootPages(page)
    const grid = page.getByRole('grid')
    // Baseline: both linked and orphan pages are present.
    await expect(grid.getByText('Getting Started')).toBeVisible()
    await expect(grid.getByText('Projects')).toBeVisible()

    await addBooleanFacet(page, 'No inbound links')

    // The chip renders…
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()
    // …and the list narrows: cross-referenced pages drop out, orphans stay.
    await expect(grid.getByText('Projects')).toBeVisible()
    await expect(grid.getByText('Meetings')).toBeVisible()
    await expect(grid.getByText('Getting Started')).toHaveCount(0)
    await expect(grid.getByText('Quick Notes')).toHaveCount(0)

    // Removing the chip widens back to the full list.
    await page.getByRole('button', { name: 'Remove filter No inbound links' }).click()
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toHaveCount(0)
    await expect(grid.getByText('Getting Started')).toBeVisible()
    await expect(grid.getByText('Quick Notes')).toBeVisible()
  })

  test('Stub narrows to zero yet keeps the chip row reachable; remove restores', async ({
    page,
  }) => {
    await bootPages(page)
    const grid = page.getByRole('grid')
    await expect(grid.getByText('Getting Started')).toBeVisible()

    await addBooleanFacet(page, 'Stub')

    // Every seeded page has children → Stub empties the result set.
    await expect(page.getByRole('group', { name: 'Filter: Stub' })).toBeVisible()
    await expect(grid.getByText('Getting Started')).toHaveCount(0)
    await expect(grid.getByText('Projects')).toHaveCount(0)
    // Crucially, the chip row stays mounted so the user can always recover.
    await expect(page.getByTestId('page-browser-filter-row')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add filter' })).toBeVisible()

    await page.getByRole('button', { name: 'Remove filter Stub' }).click()
    await expect(page.getByRole('group', { name: 'Filter: Stub' })).toHaveCount(0)
    await expect(page.getByRole('grid').getByText('Getting Started')).toBeVisible()
  })

  test('two facets AND-compose and chip removal is selective', async ({ page }) => {
    await bootPages(page)
    const grid = page.getByRole('grid')

    // Add "No inbound links" (keeps orphan pages) then "Stub" (needs 0
    // children) — the intersection is empty for the seed.
    await addBooleanFacet(page, 'No inbound links')
    await addBooleanFacet(page, 'Stub')

    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Filter: Stub' })).toBeVisible()
    await expect(grid.getByText('Projects')).toHaveCount(0)

    // Remove ONLY the Stub chip — the other chip survives and the
    // no-inbound result set returns.
    await page.getByRole('button', { name: 'Remove filter Stub' }).click()
    await expect(page.getByRole('group', { name: 'Filter: Stub' })).toHaveCount(0)
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()
    await expect(page.getByRole('grid').getByText('Projects')).toBeVisible()
  })

  test('Escape closes the popover and restores focus to the trigger', async ({ page }) => {
    await bootPages(page)
    const addFilter = page.getByRole('button', { name: 'Add filter' })
    await addFilter.click()
    await expect(activePopover(page)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(activePopover(page)).toHaveCount(0)
    // Keyboard users land back on the affordance they opened.
    await expect(addFilter).toBeFocused()
  })

  test('virtualizes and paginates a large page set', async ({ page }) => {
    // 80 bulk + 6 seed pages = 86, well past the 50-row first page.
    await bootPages(page, { extraPages: 80 })
    const grid = page.getByRole('grid')
    await expect(grid.getByText('Bulk Page 001', { exact: true })).toBeVisible()

    // Virtualization: only a small window of the 86 pages is in the DOM.
    expect(await grid.getByRole('row').count()).toBeLessThan(40)
    // Pagination: the first page didn't pull the whole set.
    await expect(page.getByRole('button', { name: /load more/i })).toBeVisible()
    // A late page is neither fetched nor virtualized in yet.
    await expect(grid.getByText('Bulk Page 080', { exact: true })).toHaveCount(0)

    // Scrolling drives cursor pagination + virtualization until the last page
    // renders — exercising the keyset cursor across multiple fetches.
    await expect
      .poll(
        async () => {
          await scrollGridToBottom(page)
          return grid.getByText('Bulk Page 080', { exact: true }).count()
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)
    await expect(grid.getByText('Bulk Page 080', { exact: true })).toBeVisible()
    // No keyset boundary duplicated the row we scrolled to.
    await expect(grid.getByText('Bulk Page 080', { exact: true })).toHaveCount(1)
  })

  test('paginates a filtered large set (No inbound links)', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    const grid = page.getByRole('grid')

    await addBooleanFacet(page, 'No inbound links')
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()

    // 80 bulk + 4 seed orphans all match → still more than one result page.
    await expect(page.getByRole('button', { name: /load more/i })).toBeVisible()
    await expect(grid.getByText('Bulk Page 001', { exact: true })).toBeVisible()
    await expect(grid.getByText('Bulk Page 080', { exact: true })).toHaveCount(0)

    await expect
      .poll(
        async () => {
          await scrollGridToBottom(page)
          return grid.getByText('Bulk Page 080', { exact: true }).count()
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)
    // Linked pages stay excluded even deep into the filtered, paginated set.
    await expect(grid.getByText('Getting Started', { exact: true })).toHaveCount(0)
  })

  test('clears the saved scroll offset when a filter changes', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    const offsetPrefix = 'pageBrowser:scrollOffset:'
    const savedKey = () =>
      page.evaluate(
        (p) => Object.keys(sessionStorage).find((k) => k.startsWith(p)) ?? null,
        offsetPrefix,
      )

    // Scrolling persists a (debounced) offset for this space.
    await scrollGridToBottom(page)
    await expect.poll(savedKey).not.toBeNull()

    // Adding a filter invalidates the saved position against the new result set.
    await addBooleanFacet(page, 'No inbound links')
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()
    await expect.poll(savedKey).toBeNull()
  })

  test('Tag inline editor: Back returns to the menu, Enter applies a chip', async ({ page }) => {
    await bootPages(page)
    await openAddFilter(page)
    const pop = activePopover(page)

    await pop.getByRole('button', { name: /^Tag/ }).click()
    // Back returns to the category menu.
    await pop.getByRole('button', { name: 'Back' }).click()
    // The Stub menu item's accessible name now carries its description tail,
    // so anchor on the label prefix rather than matching exactly.
    await expect(pop.getByRole('button', { name: /^Stub/ })).toBeVisible()

    // Re-open, type, and apply with Enter.
    await pop.getByRole('button', { name: /^Tag/ }).click()
    const input = pop.getByPlaceholder('Tag id')
    await input.fill('work')
    await input.press('Enter')
    await expect(page.getByRole('group', { name: /Filter: tag:/ })).toBeVisible()
  })

  test('Page-path inline editor adds a chip', async ({ page }) => {
    await bootPages(page)
    await openAddFilter(page)
    const pop = activePopover(page)
    await pop.getByRole('button', { name: /^Page path/ }).click()
    await pop.getByPlaceholder('e.g. Projects/*').fill('Projects/*')
    await pop.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByRole('group', { name: 'Filter: path: Projects/*' })).toBeVisible()
  })

  test('Has-property editor adds a key=value chip', async ({ page }) => {
    await bootPages(page)
    await openAddFilter(page)
    const pop = activePopover(page)
    await pop.getByRole('button', { name: /^Has property/ }).click()
    await pop.getByPlaceholder('Property key').fill('status')
    // Default op is `is` (Eq) → the value input is shown and required.
    await pop.getByPlaceholder('Value', { exact: true }).fill('active')
    await pop.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByRole('group', { name: 'Filter: status = active' })).toBeVisible()
  })

  test('Priority and Last-edited quick-picks add chips', async ({ page }) => {
    await bootPages(page)
    await openAddFilter(page)
    await activePopover(page).getByRole('button', { name: '1', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Filter: priority 1' })).toBeVisible()

    await openAddFilter(page)
    await activePopover(page).getByRole('button', { name: 'Edited today' }).click()
    await expect(page.getByRole('group', { name: 'Filter: Edited today' })).toBeVisible()
  })

  test('does not jump to the top when a page loads in mid-scroll', async ({ page }) => {
    await bootPages(page, { extraPages: 80 })
    const grid = page.getByRole('grid')
    await expect(grid.getByText('Bulk Page 001', { exact: true })).toBeVisible()

    const initialScrollHeight = await grid.evaluate((el) => el.scrollHeight)
    // Scroll to the bottom of the first page to trigger one cursor fetch.
    await grid.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    // Wait until the next page has hydrated (content grew).
    await page.waitForFunction(
      (h) => (document.querySelector('[role="grid"]') as HTMLElement).scrollHeight > h,
      initialScrollHeight,
    )
    // The viewport must hold the user's position — not snap back to the top.
    expect(await grid.evaluate((el) => el.scrollTop)).toBeGreaterThan(200)
  })

  test('shows the soft-cap warning once the chip limit is reached', async ({ page }) => {
    await bootPages(page)
    // The chip set dedupes structurally-identical primitives (PEND-58d D22),
    // so eight *distinct* chips are needed to reach MAX_PAGE_FILTERS (8). Use
    // eight different path globs — each is a unique `PathGlob{pattern}` so none
    // collapse, and none narrow the seed to zero in a way that hides the row.
    for (let i = 0; i < 8; i++) {
      await openAddFilter(page)
      const pop = activePopover(page)
      await pop.getByRole('button', { name: /^Page path/ }).click()
      await pop.getByPlaceholder('e.g. Projects/*').fill(`p${i}`)
      await pop.getByRole('button', { name: 'Apply' }).click()
    }
    await expect(page.getByRole('group', { name: /^Filter: path:/ })).toHaveCount(8)

    // The ninth Add-Filter open surfaces the soft-cap warning note.
    await openAddFilter(page)
    await expect(activePopover(page).getByText('Many filters can slow the view.')).toBeVisible()
  })

  test('dedupes a structurally-identical chip (re-adding Orphan is a no-op)', async ({ page }) => {
    await bootPages(page)
    // PEND-58d D22 — re-applying the same boolean facet must not stack a
    // duplicate pill (an AND of a condition with itself is pure noise).
    await addBooleanFacet(page, 'Orphan')
    await expect(page.getByRole('group', { name: 'Filter: Orphan' })).toHaveCount(1)
    await addBooleanFacet(page, 'Orphan')
    await expect(page.getByRole('group', { name: 'Filter: Orphan' })).toHaveCount(1)
  })

  test('paginates a filtered set under the recently-modified (string-keyset) sort', async ({
    page,
  }) => {
    await bootPages(page, { extraPages: 80 })
    // Switch to a string-keyset sort — the cursor path the backend review
    // flagged as least-tested — then layer a filter and paginate across it.
    await page.getByRole('combobox', { name: 'Sort order' }).click()
    await page.getByRole('option', { name: 'Recently modified' }).click()

    await addBooleanFacet(page, 'No inbound links')
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()

    const grid = page.getByRole('grid')
    await expect(page.getByRole('button', { name: /load more/i })).toBeVisible()
    // Canonical pages sort last under recently-modified, so the template page is
    // on a later result page; reaching it exercises the string-keyset cursor
    // across fetches. (Bulk pages can't anchor this assertion — the mock derives
    // `lastModifiedAt` from the id prefix, which isn't monotonic with their index.)
    await expect(grid.getByText('Meeting Notes Template', { exact: true })).toHaveCount(0)
    await expect
      .poll(
        async () => {
          await scrollGridToBottom(page)
          return grid.getByText('Meeting Notes Template', { exact: true }).count()
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0)
  })

  test('free-text search composes with a compound chip', async ({ page }) => {
    await bootPages(page)
    const grid = page.getByRole('grid')

    // Server-side chip keeps the orphan pages (incl. Projects + the Meeting pages).
    await addBooleanFacet(page, 'No inbound links')
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()
    await expect(grid.getByText('Projects', { exact: true })).toBeVisible()

    // Client-side text filter narrows the chip-filtered set further.
    await page.getByPlaceholder('Search pages...').fill('Meet')
    await expect(grid.getByText('Meetings', { exact: true })).toBeVisible()
    await expect(grid.getByText('Meeting Notes Template', { exact: true })).toBeVisible()
    await expect(grid.getByText('Projects', { exact: true })).toHaveCount(0)
  })
})
