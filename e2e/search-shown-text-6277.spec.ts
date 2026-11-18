/**
 * E2E — search matches block text as the editor shows it (#6277 B3): a
 * backslash escape is found by the character it shows, and a `((ULID))` block
 * ref by its target's first line. The mock strips each block at query time
 * (`stripForFts`) but returns no snippet, so a row here shows raw content; the
 * referrer's row text, and an edit to the target re-stripping its referrer in
 * the backend's index, are the `@real-only` test below.
 */

import {
  expect,
  expectSearchListed,
  ipc,
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

  // `@real-only`: the mock strips at query time, so only the backend's index can keep the
  // referrer's row under the target's old first line.
  test(
    "a block ref is found by its target's new first line, and not by its old one",
    { tag: '@real-only' },
    async ({ page }) => {
      const [kept, target] = await seedSearchBlocks(page, [
        { content: 'kept amberine' },
        { content: 'target amberine' },
      ])
      const [ref] = await seedSearchBlocks(page, [{ content: `referrer see ((${target}))` }])
      await expectSearchListed(page, 'amberine', [kept as string, target as string, ref as string])

      await ipc(page, 'edit_block', { blockId: target, toText: 'target cobaltine' })
      await expectSearchListed(page, 'cobaltine', [target as string, ref as string])
      // The row shows the indexed text: the target's line, not the ref.
      const row = page.getByTestId(`search-result-row-${ref}`)
      await expect(row).toContainText('cobaltine')
      await expect(row).not.toHaveText(/\(\(|[0-9A-Z]{26}/)
      await expectSearchListed(page, 'amberine', [kept as string])
    },
  )

  test("a block ref is no longer found by a purged target's first line (#6843)", async ({
    page,
  }) => {
    const [kept, target] = await seedSearchBlocks(page, [
      { content: 'kept garnetine' },
      { content: 'target garnetine' },
    ])
    const [ref] = await seedSearchBlocks(page, [{ content: `referrer see ((${target}))` }])
    await expectSearchListed(page, 'garnetine', [kept as string, target as string, ref as string])

    await ipc(page, 'delete_block', { blockId: target })
    await ipc(page, 'purge_block', { blockId: target })
    await expectSearchListed(page, 'garnetine', [kept as string])
  })
})
