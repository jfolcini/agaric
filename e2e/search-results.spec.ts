/**
 * E2E — PEND-58f search results: grouping + click-through + keyboard nav
 * (E2E-8) and the alias-match card (E2E-9).
 *
 * The mock `search_blocks` handler returns raw seed blocks with NO
 * `snippet` / `match_offsets` fields, so `SearchResultBlockRow` always falls
 * back to plain content — the `<mark>` highlight path is unreachable on this
 * harness (it needs the real FTS `snippet()` output). That sub-item of E2E-8
 * is therefore covered by the unit layer (`SnippetHighlight.test.tsx`) and
 * skipped here with a note; the grouping / click-through / keyboard-nav flows
 * are fully exercised below.
 */

import { expect, openSearchView, test } from './helpers'

/** Run a query from the search view and wait for the result region. */
async function runSearch(page: import('@playwright/test').Page, query: string) {
  const input = page.getByPlaceholder('Search blocks...')
  await input.fill(query)
  await input.press('Enter')
  const region = page.getByTestId('search-result-region')
  await expect(region).toBeVisible()
  return region
}

test.describe('Search results — grouping + interaction (PEND-58f E2E-8)', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('results group by page with per-group match counts', async ({ page }) => {
    // "Review" matches seed blocks across two pages:
    //   - PAGE_DAILY: "Review project milestones", "Review pull requests"
    //   - PAGE_MEETINGS: "Design review feedback"
    const region = await runSearch(page, 'Review')
    const groups = region.locator('[data-testid^="search-result-group-"]')
    await expect(groups).toHaveCount(2)
    // The result-count summary above the groups reflects the totals.
    await expect(region).toContainText(/3 matches in 2 pages/)
  })

  test('clicking a result row navigates to its page', async ({ page }) => {
    const region = await runSearch(page, 'Welcome')
    // "Welcome to Agaric!..." lives under "Getting Started".
    const firstRow = region.locator('[role="option"]').first()
    await expect(firstRow).toBeVisible()
    await firstRow.click()
    // Navigation lands on the result's OWNING page — "Welcome…" lives under
    // "Getting Started", so assert WHICH page we landed on, not just that a
    // title region is visible.
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })

  test('keyboard ArrowDown roves the active option', async ({ page }) => {
    const region = await runSearch(page, 'Review')
    const listbox = region.locator('[role="listbox"]').first()
    await listbox.focus()
    await listbox.press('ArrowDown')
    // The roving model marks exactly one option aria-selected=true.
    await expect(region.locator('[role="option"][aria-selected="true"]')).toHaveCount(1)
  })

  test('keyboard Enter activates the focused option → navigates', async ({ page }) => {
    // "Welcome..." is a single result under the normal "Getting Started" page
    // (not the journal/daily page, which would open the journal view instead).
    const region = await runSearch(page, 'Welcome')
    const listbox = region.locator('[role="listbox"]').first()
    await listbox.focus()
    // focusedIndex defaults to 0 (the first flat row); Enter selects it and
    // navigates to that block's owning page.
    await listbox.press('Enter')
    // "Welcome…" (the first flat row) navigates to its owning "Getting Started"
    // page — assert the specific destination, not just any title region.
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })

  // E2E-A3 — Load-More / pagination.
  //
  // The product paginates results via cursor + `PAGINATION_LIMIT` (50) and
  // renders a "Load more" button (`LoadMoreButton`) only while
  // `usePaginatedQuery.hasMore` is true (it derives directly from the IPC
  // `has_more` flag). On the web+mock harness the `search_blocks` handler
  // (`src/lib/tauri-mock/handlers.ts`) returns the ENTIRE folded match set in
  // one page with `next_cursor: null, has_more: false` — it ignores the
  // `cursor` / `limit` args entirely. The seed data also tops out at a
  // handful of blocks per query, far under the 50-row page size, so a second
  // page can never be produced here. The Load-More affordance is therefore
  // unreachable on this harness; we assert its ABSENCE on a query that *does*
  // return multiple rows (so the check isn't vacuous on an empty result set).
  // The append-on-load-more growth path is covered at the hook layer
  // (`usePaginatedQuery` tests).
  test('multi-result query renders rows but no Load-More control (mock returns a single page)', async ({
    page,
  }) => {
    // "Review" matches 3 seed blocks across 2 pages (see the grouping test
    // above) — a real, multi-row result set.
    const region = await runSearch(page, 'Review')
    // Sanity: rows actually rendered, so the absence assertion below is
    // meaningful rather than trivially true on a blank panel.
    await expect(region.locator('[role="option"]')).toHaveCount(3)
    // The mock answers in one page (`has_more: false`), so `LoadMoreButton`
    // returns null and no "Load more" button is mounted.
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0)
  })

  // `<mark>` highlight needs the FTS `snippet()` output the mock never
  // produces; covered at the unit layer (SnippetHighlight.test.tsx).
  test.skip('result snippets render <mark> highlight runs', () => {
    // Unreachable on web+mock: the mock returns blocks without a `snippet`
    // field, so `SearchResultBlockRow` renders plain content (no <mark>).
  })
})

test.describe('Search alias-match card (PEND-58f E2E-9)', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('typing a page alias surfaces the alias-match card', async ({ page }) => {
    // Seed alias: 'gs' → "Getting Started" (SPACE_PERSONAL). No block content
    // contains "gs", so FTS returns nothing and the alias card stands alone.
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('gs')
    await input.press('Enter')

    const card = page.getByTestId('alias-match')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Getting Started')
    // The card carries the "via alias" label.
    await expect(page.getByTestId('alias-match-label')).toContainText(/via alias: gs/)
  })

  test('clicking the alias-match card navigates to the page', async ({ page }) => {
    // Use 'getting-started' (a seed alias for "Getting Started"). No seed block
    // content contains that string, so the FTS set is empty and the alias card
    // is NOT suppressed by a duplicate result row.
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('getting-started')
    await input.press('Enter')
    const card = page.getByTestId('alias-match')
    await expect(card).toBeVisible()
    await expect(card).toContainText('Getting Started')
    await card.getByRole('button').first().click()
    // The alias 'getting-started' resolves to the "Getting Started" page — assert
    // we landed there specifically.
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })
})
