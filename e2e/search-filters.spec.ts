/**
 * E2E — search-view filters: the Add filter builder (E2E-3), chip
 * lifecycle (E2E-4), and each structured-DSL token narrowing the rendered
 * results (E2E-6), seeded with blocks the filter must keep and must drop.
 */

import {
  expect,
  openSearchView,
  type SearchSeed,
  searchResultIds,
  seedSearchBlocks,
  submitSearch,
  test,
} from './helpers'

// ===========================================================================
// E2E-3 — Add filter builder popover
// ===========================================================================

test.describe('Filter helper popover (E2E-3) @search', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('opens the category menu', async ({ page }) => {
    await page.getByTestId('add-filter-button').click()
    await expect(page.getByTestId('filter-helper-menu')).toBeVisible()
    await expect(page.getByText('Page path (include)')).toBeVisible()
    await expect(page.getByText('Page path (exclude)')).toBeVisible()
  })

  test('adds a tag filter via the tag picker → chip', async ({ page }) => {
    await page.getByTestId('add-filter-button').click()
    await page.getByText('Tag', { exact: true }).click()
    const tagPicker = page.getByTestId('filter-helper-tag')
    await expect(tagPicker).toBeVisible()
    // Seed tags (work / personal / idea) come from `list_tags_by_prefix`.
    // The tag items are `role="option"` (combobox/listbox a11y), not buttons.
    await tagPicker.getByRole('option', { name: '#work' }).click()
    // The popover closes and a `tag:#work` chip appears in the chip bar.
    await expect(page.getByTestId('filter-chip-bar')).toContainText('tag:#work')
    await expect(page.getByPlaceholder('Search blocks...')).toHaveValue(/tag:#work/)
  })

  test('adds a path:include filter via the text form → chip', async ({ page }) => {
    await page.getByTestId('add-filter-button').click()
    await page.getByText('Page path (include)').click()
    const form = page.getByTestId('path-filter-input')
    await expect(form).toBeVisible()
    await form.getByRole('textbox').fill('Journal/2026-*')
    await form.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByTestId('filter-chip-bar')).toContainText('path:Journal/2026-*')
  })

  test('adds a not-path:exclude filter via the text form → chip', async ({ page }) => {
    await page.getByTestId('add-filter-button').click()
    await page.getByText('Page path (exclude)').click()
    const form = page.getByTestId('path-filter-input')
    await expect(form).toBeVisible()
    await form.getByRole('textbox').fill('Archive/**')
    await form.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByTestId('filter-chip-bar')).toContainText('not-path:Archive/**')
  })
})

// ===========================================================================
// E2E-4 — chip lifecycle
// ===========================================================================

test.describe('Filter chip lifecycle (E2E-4) @search', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('typing a structured token renders a chip', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('state:TODO hello')
    const bar = page.getByTestId('filter-chip-bar')
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('state:TODO')
  })

  test('removing a chip drops the token from the query string', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('tag:#work foo')
    const bar = page.getByTestId('filter-chip-bar')
    await expect(bar).toContainText('tag:#work')
    // FilterPill renders a remove control labelled "Remove filter <token>".
    await bar.getByRole('button', { name: /Remove filter tag:#work/ }).click()
    await expect(bar).not.toContainText('tag:#work')
    // Free text survives the removal.
    await expect(input).toHaveValue(/foo/)
  })

  test('clear-all removes every chip but keeps the live free text', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('tag:#work state:TODO keepme')
    const bar = page.getByTestId('filter-chip-bar')
    await expect(bar).toContainText('tag:#work')
    await expect(bar).toContainText('state:TODO')
    await bar.getByRole('button', { name: 'Clear all' }).click()
    await expect(bar).not.toContainText('tag:#work')
    await expect(bar).not.toContainText('state:TODO')
    // Clear-all preserves the just-typed free text.
    await expect(input).toHaveValue(/keepme/)
  })

  test('an unparseable structured token renders an invalid chip', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    // `due:` with a garbage value is classified as an invalid filter token →
    // red invalid chip carrying the typed error in its group label.
    await input.fill('due:notadate')
    const bar = page.getByTestId('filter-chip-bar')
    await expect(bar).toBeVisible()
    // The invalid chip exposes the localised "Invalid filter: <label> — <error>"
    // accessible name on its group wrapper (#2262 carries the parser error in
    // the name, not just "invalid").
    await expect(bar.getByRole('group', { name: /Invalid filter/ })).toBeVisible()
  })
})

// ===========================================================================
// E2E-6 — structured DSL filters narrow the rendered results
// ===========================================================================

const MARK = 'quokka'
const TAG_WORK_ID = '000000000000000000000TAG01'
const TAG_PERSONAL_ID = '000000000000000000000TAG02'
const PAGE_MEETINGS = '00000000000000000000PAGE05'

type Seed = Omit<SearchSeed, 'content'>

/** Seed `keep` and `drop` blocks that all hold `MARK`; `<token> MARK` must render exactly `keep`. */
async function expectFilterKeeps(
  page: import('@playwright/test').Page,
  token: string,
  keep: Seed[],
  drop: Seed[],
): Promise<void> {
  const ids = await seedSearchBlocks(
    page,
    [...keep, ...drop].map((seed, i) => Object.assign({ content: `${MARK} ${i}` }, seed)),
  )
  await submitSearch(page, `${token} ${MARK}`)
  await expect.poll(() => searchResultIds(page)).toEqual(ids.slice(0, keep.length).toSorted())
}

test.describe('Structured DSL filters narrow the results (E2E-6) @search', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('state: keeps blocks in that state', async ({ page }) => {
    await expectFilterKeeps(page, 'state:TODO', [{ todo: 'TODO' }], [{ todo: 'DONE' }, {}])
  })

  test('path: keeps blocks on pages whose title matches the glob', async ({ page }) => {
    await expectFilterKeeps(page, 'path:Proj*', [{}], [{ parentId: PAGE_MEETINGS }])
  })

  test('due: bucket keeps blocks due in it', async ({ page }) => {
    await expectFilterKeeps(page, 'due:today', [{ due: 0 }], [{ due: 1 }, {}])
  })

  test('due: comparison keeps blocks due on or after the date', async ({ page }) => {
    await expectFilterKeeps(
      page,
      'due:>=2026-01-01',
      [{ due: '2026-01-01' }, { due: '2026-03-01' }],
      [{ due: '2025-12-31' }, {}],
    )
  })

  test('prop: keeps blocks with that key and value', async ({ page }) => {
    await expectFilterKeeps(
      page,
      'prop:project=alpha',
      [{ props: { project: 'alpha' } }],
      [{ props: { project: 'beta' } }, {}],
    )
  })

  test('tag: keeps blocks carrying the named tag', async ({ page }) => {
    await expectFilterKeeps(
      page,
      'tag:#work',
      [{ tagIds: [TAG_WORK_ID] }],
      [{ tagIds: [TAG_PERSONAL_ID] }, {}],
    )
  })

  // E2E-A1 — negated filters keep the NULL bucket (`NOT IN` is NULL-inclusive).
  test('not-state: drops blocks in that state and keeps stateless ones', async ({ page }) => {
    await expectFilterKeeps(page, 'not-state:DONE', [{ todo: 'TODO' }, {}], [{ todo: 'DONE' }])
  })

  test('not-priority: drops blocks at that priority and keeps unprioritised ones', async ({
    page,
  }) => {
    await expectFilterKeeps(page, 'not-priority:3', [{ priority: '1' }, {}], [{ priority: '3' }])
  })

  test('not-prop: drops blocks with that key and value', async ({ page }) => {
    await expectFilterKeeps(
      page,
      'not-prop:archived=true',
      [{ props: { archived: 'false' } }, {}],
      [{ props: { archived: 'true' } }],
    )
  })

  // E2E-A2 — `scheduled:` parallels `due:`.
  test('scheduled: bucket keeps blocks scheduled in it', async ({ page }) => {
    await expectFilterKeeps(page, 'scheduled:today', [{ scheduled: 0 }], [{ scheduled: 1 }, {}])
  })

  test('scheduled: comparison keeps blocks scheduled on or after the date', async ({ page }) => {
    await expectFilterKeeps(
      page,
      'scheduled:>=2026-01-01',
      [{ scheduled: '2026-01-01' }, { scheduled: '2026-03-01' }],
      [{ scheduled: '2025-12-31' }, {}],
    )
  })

  // E2E-A11
  test('not-path: drops blocks on pages whose title matches the glob', async ({ page }) => {
    await expectFilterKeeps(page, 'not-path:Proj*', [{ parentId: PAGE_MEETINGS }], [{}])
  })

  // E2E-A8 — a trailing `=` filters on key presence. The key has no
  // definition: a declared select such as `status` offers its options, and
  // Enter picks the first.
  test('prop: with an empty value keeps blocks that have the key', async ({ page }) => {
    await expectFilterKeeps(page, 'prop:mood=', [{ props: { mood: 'calm' } }], [{}])
  })
})
