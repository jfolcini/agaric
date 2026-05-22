import { activePopover, expect, test, waitForBoot } from './helpers'

/**
 * E2E coverage for PEND-58 — Pages-view compound-filter chip-row.
 *
 * The chip-row is the default Pages experience (the `pageBrowser.densityV1`
 * localStorage flag is now an OPT-OUT: only the literal string `'false'`
 * falls back to the legacy `listBlocks` path). The app reads the flag once at
 * mount, so flag-setting tests register an init script BEFORE `waitForBoot`'s
 * `page.goto('/')`.
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
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(page.getByRole('grid')).toBeVisible()
}

interface BootOpts {
  /** `'off'` exercises the legacy `listBlocks` path (no chip row). */
  flag?: 'default' | 'off'
  /** Seed N extra "Bulk Page NNN" pages for pagination / virtualization. */
  extraPages?: number
}

/** Set localStorage flags before boot, then open the Pages view. */
async function bootPages(
  page: import('@playwright/test').Page,
  opts: BootOpts = {},
): Promise<void> {
  const { flag = 'default', extraPages = 0 } = opts
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
  test('renders the chip row by default (densityV1 is opt-out)', async ({ page }) => {
    // No flag set — the default-on flip means the chip row must appear.
    await bootPages(page)
    await expect(page.getByRole('button', { name: 'Add filter' })).toBeVisible()
    await expect(page.getByTestId('page-browser-filter-row')).toBeVisible()
  })

  test('hides the chip row on the legacy path (densityV1 = false)', async ({ page }) => {
    await bootPages(page, { flag: 'off' })
    await expect(page.getByRole('button', { name: 'Add filter' })).toHaveCount(0)
    await expect(page.getByTestId('page-browser-filter-row')).toHaveCount(0)
  })

  test('Add-Filter popover offers the shared and Pages-only facets', async ({ page }) => {
    await bootPages(page)
    await page.getByRole('button', { name: 'Add filter' }).click()
    const pop = activePopover(page)
    await expect(pop).toBeVisible()

    // Category headings.
    await expect(pop.getByText('Filters', { exact: true })).toBeVisible()
    await expect(pop.getByText('Pages', { exact: true })).toBeVisible()

    // Shared value-facets + Pages-only boolean facets.
    for (const facet of [
      'Tag',
      'Page path',
      'Has property',
      'Orphan',
      'Stub',
      'No inbound links',
    ]) {
      await expect(pop.getByRole('button', { name: facet, exact: true })).toBeVisible()
    }
    // Last-edited buckets + Priority quick-picks render as inline buttons.
    await expect(pop.getByRole('button', { name: 'Edited today' })).toBeVisible()
    await expect(pop.getByText('Priority', { exact: true })).toBeVisible()
    await expect(pop.getByRole('button', { name: 'A', exact: true })).toBeVisible()

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

    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'No inbound links', exact: true }).click()

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

    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'Stub', exact: true }).click()

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
    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'No inbound links', exact: true }).click()
    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'Stub', exact: true }).click()

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

    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'No inbound links', exact: true }).click()
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
    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'No inbound links', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()
    await expect.poll(savedKey).toBeNull()
  })

  test('Tag inline editor: Back returns to the menu, Enter applies a chip', async ({ page }) => {
    await bootPages(page)
    await page.getByRole('button', { name: 'Add filter' }).click()
    const pop = activePopover(page)

    await pop.getByRole('button', { name: 'Tag', exact: true }).click()
    // Back returns to the category menu.
    await pop.getByRole('button', { name: 'Back' }).click()
    await expect(pop.getByRole('button', { name: 'Stub', exact: true })).toBeVisible()

    // Re-open, type, and apply with Enter.
    await pop.getByRole('button', { name: 'Tag', exact: true }).click()
    const input = pop.getByPlaceholder('Tag name or id')
    await input.fill('work')
    await input.press('Enter')
    await expect(page.getByRole('group', { name: /Filter: tag:/ })).toBeVisible()
  })

  test('Page-path inline editor adds a chip', async ({ page }) => {
    await bootPages(page)
    await page.getByRole('button', { name: 'Add filter' }).click()
    const pop = activePopover(page)
    await pop.getByRole('button', { name: 'Page path', exact: true }).click()
    await pop.getByPlaceholder('e.g. Projects/*').fill('Projects/*')
    await pop.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByRole('group', { name: 'Filter: path: Projects/*' })).toBeVisible()
  })

  test('Has-property editor adds a key=value chip', async ({ page }) => {
    await bootPages(page)
    await page.getByRole('button', { name: 'Add filter' }).click()
    const pop = activePopover(page)
    await pop.getByRole('button', { name: 'Has property', exact: true }).click()
    await pop.getByPlaceholder('Property key').fill('status')
    await pop.getByPlaceholder('Value (optional)').fill('active')
    await pop.getByRole('button', { name: 'Apply' }).click()
    await expect(page.getByRole('group', { name: 'Filter: status = active' })).toBeVisible()
  })

  test('Priority and Last-edited quick-picks add chips', async ({ page }) => {
    await bootPages(page)
    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'A', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Filter: priority A' })).toBeVisible()

    await page.getByRole('button', { name: 'Add filter' }).click()
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
    // Eight boolean chips (each gets a distinct _addId) reach the soft cap.
    for (let i = 0; i < 8; i++) {
      await page.getByRole('button', { name: 'Add filter' }).click()
      await activePopover(page).getByRole('button', { name: 'Orphan', exact: true }).click()
    }
    await expect(page.getByRole('group', { name: 'Filter: Orphan' })).toHaveCount(8)

    await page.getByRole('button', { name: 'Add filter' }).click()
    await expect(activePopover(page).getByText('Many filters can slow the view.')).toBeVisible()
  })

  test('paginates a filtered set under the recently-modified (string-keyset) sort', async ({
    page,
  }) => {
    await bootPages(page, { extraPages: 80 })
    // Switch to a string-keyset sort — the cursor path the backend review
    // flagged as least-tested — then layer a filter and paginate across it.
    await page.getByRole('combobox', { name: 'Sort order' }).click()
    await page.getByRole('option', { name: 'Recently modified' }).click()

    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'No inbound links', exact: true }).click()
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
    await page.getByRole('button', { name: 'Add filter' }).click()
    await activePopover(page).getByRole('button', { name: 'No inbound links', exact: true }).click()
    await expect(page.getByRole('group', { name: 'Filter: No inbound links' })).toBeVisible()
    await expect(grid.getByText('Projects', { exact: true })).toBeVisible()

    // Client-side text filter narrows the chip-filtered set further.
    await page.getByPlaceholder('Search pages...').fill('Meet')
    await expect(grid.getByText('Meetings', { exact: true })).toBeVisible()
    await expect(grid.getByText('Meeting Notes Template', { exact: true })).toBeVisible()
    await expect(grid.getByText('Projects', { exact: true })).toHaveCount(0)
  })
})
