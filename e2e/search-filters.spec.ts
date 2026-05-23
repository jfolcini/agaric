/**
 * E2E — PEND-58f search-view filters: the `+ Filter` builder (E2E-3), chip
 * lifecycle (E2E-4), and structured-DSL → IPC-param marshalling (E2E-6).
 *
 * The web+mock harness has no real SQL filtering (the mock `search_blocks`
 * handler folds on content and ignores the `SearchFilter` struct), so E2E-6
 * cannot assert a *filtered result set*. Instead we assert the panel marshals
 * each DSL token into the correct IPC `filter` param — the contract the real
 * backend consumes. The chip + popover flows are pure DOM and fully covered.
 */

import {
  clearInvokeCalls,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  openSearchView,
  test,
} from './helpers'

const TAG_WORK_ID = '000000000000000000000TAG01'

/** Latest recorded `search_blocks` filter payload. */
async function latestFilter(
  page: import('@playwright/test').Page,
): Promise<Record<string, unknown>> {
  const calls = await getInvokeCalls(page, 'search_blocks')
  return calls[calls.length - 1]?.['filter'] as Record<string, unknown>
}

/** Type a query, submit, and wait until a `search_blocks` IPC matching the
 *  predicate has been recorded (handles the async tag-id re-fire). */
async function searchUntil(
  page: import('@playwright/test').Page,
  query: string,
  predicate: (filter: Record<string, unknown>) => boolean,
) {
  await clearInvokeCalls(page)
  const input = page.getByPlaceholder('Search blocks...')
  await input.fill(query)
  await input.press('Enter')
  await expect
    .poll(async () => {
      const calls = await getInvokeCalls(page, 'search_blocks')
      return calls.some((c) => predicate(c['filter'] as Record<string, unknown>))
    })
    .toBe(true)
}

// ===========================================================================
// E2E-3 — `+ Filter` builder popover
// ===========================================================================

test.describe('Filter helper popover (PEND-58f E2E-3)', () => {
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
    await tagPicker.getByRole('button', { name: '#work' }).click()
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

test.describe('Filter chip lifecycle (PEND-58f E2E-4)', () => {
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
    // FE-6 — clear-all preserves the just-typed free text.
    await expect(input).toHaveValue(/keepme/)
  })

  test('an unparseable structured token renders an invalid chip', async ({ page }) => {
    const input = page.getByPlaceholder('Search blocks...')
    // `due:` with a garbage value is classified as an invalid filter token →
    // red invalid chip carrying the typed error in its group label.
    await input.fill('due:notadate')
    const bar = page.getByTestId('filter-chip-bar')
    await expect(bar).toBeVisible()
    // The invalid chip exposes the localised "Invalid filter token" label
    // on its group wrapper.
    await expect(bar.getByRole('group', { name: /Invalid filter token/ })).toBeVisible()
  })
})

// ===========================================================================
// E2E-6 — structured DSL filters → IPC params
// ===========================================================================

test.describe('Structured DSL filters → IPC params (PEND-58f E2E-6)', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
    await installIpcRecorder(page)
  })

  test('state: token → filter.stateFilter', async ({ page }) => {
    await searchUntil(
      page,
      'state:TODO',
      (f) => Array.isArray(f['stateFilter']) && (f['stateFilter'] as string[]).includes('TODO'),
    )
    const filter = await latestFilter(page)
    expect(filter['stateFilter']).toContain('TODO')
  })

  test('path: token → filter.includePageGlobs', async ({ page }) => {
    await searchUntil(
      page,
      'path:Journal/2026-*',
      (f) =>
        Array.isArray(f['includePageGlobs']) &&
        (f['includePageGlobs'] as string[]).includes('Journal/2026-*'),
    )
    const filter = await latestFilter(page)
    expect(filter['includePageGlobs']).toContain('Journal/2026-*')
  })

  test('due: bucket token → filter.dueFilter named range', async ({ page }) => {
    await searchUntil(page, 'due:today', (f) => {
      const due = f['dueFilter'] as Record<string, unknown> | null
      return !!due && due['named'] === 'today'
    })
    const filter = await latestFilter(page)
    expect((filter['dueFilter'] as Record<string, unknown>)['named']).toBe('today')
  })

  test('due: comparison token → filter.dueFilter op shape', async ({ page }) => {
    await searchUntil(page, 'due:>=2026-01-01', (f) => {
      const due = f['dueFilter'] as { op?: { op?: string; date?: string } } | null
      return !!due?.op && due.op.op === 'gte' && due.op.date === '2026-01-01'
    })
    const filter = await latestFilter(page)
    const due = filter['dueFilter'] as { op: { op: string; date: string } }
    expect(due.op.op).toBe('gte')
    expect(due.op.date).toBe('2026-01-01')
  })

  test('prop: token → filter.propertyFilters key/value', async ({ page }) => {
    await searchUntil(
      page,
      'prop:project=alpha',
      (f) =>
        Array.isArray(f['propertyFilters']) &&
        (f['propertyFilters'] as Array<{ key: string; value: string }>).some(
          (p) => p.key === 'project' && p.value === 'alpha',
        ),
    )
    const filter = await latestFilter(page)
    expect(filter['propertyFilters']).toContainEqual({ key: 'project', value: 'alpha' })
  })

  test('tag: token resolves the name to an id → filter.tagIds', async ({ page }) => {
    // Tag name → id resolution is async (listTagsByPrefix); the IPC re-fires
    // once the id lands. Poll until a call carries the resolved id.
    await searchUntil(
      page,
      'tag:#work',
      (f) => Array.isArray(f['tagIds']) && (f['tagIds'] as string[]).includes(TAG_WORK_ID),
    )
    const filter = await latestFilter(page)
    expect(filter['tagIds']).toContain(TAG_WORK_ID)
  })
})
