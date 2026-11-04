/**
 * E2E — search matches block text as the editor shows it (#6277 B3): a
 * backslash escape is found by the character it shows, and a `((ULID))` block
 * ref by its target's first line. The mock strips each block at query time
 * (`stripForFts`) but returns no snippet, so a row here shows raw content; the
 * referrer's row text, and an edit to the target re-stripping its referrer in
 * the backend's index, are `e2e-tauri/search-shown-text-6277.e2e.ts`.
 */

import {
  expect,
  openSearchView,
  searchResultIds,
  seedSearchBlocks,
  submitSearch,
  test,
} from './helpers'

test.describe('Search matches block text as the editor shows it (#6277) @search', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('an escaped bracket is found by the bracket', async ({ page }) => {
    const [id] = await seedSearchBlocks(page, [{ content: 'arr\\[0\\] is the first' }])
    await submitSearch(page, 'arr[0]')
    await expect.poll(() => searchResultIds(page)).toEqual([id])
  })

  test('escaped underscores are found by the underscores', async ({ page }) => {
    const [id] = await seedSearchBlocks(page, [{ content: '\\_\\_init\\_\\_ runs' }])
    await submitSearch(page, '__init__')
    await expect.poll(() => searchResultIds(page)).toEqual([id])
  })

  test("a block ref is found by its target's first line", async ({ page }) => {
    const [targetId] = await seedSearchBlocks(page, [{ content: 'Quarterly plan\nsecond line' }])
    const [refId] = await seedSearchBlocks(page, [{ content: `see ((${targetId}))` }])
    await submitSearch(page, 'Quarterly plan')
    await expect
      .poll(() => searchResultIds(page))
      .toEqual(expect.arrayContaining([refId, targetId]))
    expect(await searchResultIds(page)).toHaveLength(2)
  })
})
