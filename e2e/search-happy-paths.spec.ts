/**
 * E2E — search happy paths (#5738): Enter commits a search without waiting
 * for the debounce, and searches again on an unchanged query; a result click
 * opens its page with the block scrolled into view and focused; and the
 * palette's Toggle sidebar and Keyboard shortcuts entries. Each step is one
 * mock IPC or none, so the mock lane shows every failure.
 */

import type { Page } from '@playwright/test'

import { SEED_IDS } from '../src/lib/tauri-mock/seed'
import {
  activeSheet,
  expect,
  ipc,
  openSearchView,
  searchResultIds,
  seedSearchBlocks,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'

const MARK = 'quokka'

/**
 * The real backend indexes a block in the background, so a search waits until
 * the index holds it; the mock indexes at once.
 */
async function waitIndexed(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const found = await ipc<{ items: Array<{ id: string }> }>(page, 'search_blocks', {
          query: MARK,
          cursor: null,
          limit: 10,
          filter: { scope: { kind: 'spaces', space_ids: [SEED_IDS.SPACE_PERSONAL] } },
        })
        return found.items.map((item) => item.id)
      },
      { timeout: 15_000 },
    )
    .toContain(id)
}

test('Enter runs the search without waiting for the debounce @search', async ({ page }) => {
  await page.clock.install()
  const input = await openSearchView(page)
  const [id] = await seedSearchBlocks(page, [{ content: `${MARK} on enter` }])
  // Paused, the input's debounce never fires: a result can only come from Enter.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)

  await input.fill(MARK)
  await input.press('Enter')
  // `runFor(0)` fires only timers already due (TanStack Query's zero-delay
  // notify), so the clock never reaches the debounce.
  await expect
    .poll(async () => {
      await page.clock.runFor(0)
      return searchResultIds(page)
    })
    .toEqual([id])
})

// A block written just before a search can miss the index; Enter again retries.
test('Enter on an unchanged query searches again and lists a block indexed since @search', async ({
  page,
}) => {
  await openSearchView(page)
  const [before = ''] = await seedSearchBlocks(page, [{ content: `${MARK} before` }])
  await waitIndexed(page, before)
  await submitSearch(page, MARK)
  await expect.poll(() => searchResultIds(page)).toEqual([before])

  const [after = ''] = await seedSearchBlocks(page, [{ content: `${MARK} after` }])
  await waitIndexed(page, after)
  await page.getByRole('combobox', { name: 'Search blocks' }).press('Enter')

  await expect.poll(() => searchResultIds(page)).toEqual([before, after].toSorted())
})

test('clicking a result opens its page with the block in view and focused @search', async ({
  page,
}) => {
  await openSearchView(page)
  // Far past the tree's initial render window, so the row starts below the fold.
  const ids = await seedSearchBlocks(page, [
    ...Array.from({ length: 60 }, (_, i) => ({ content: `filler row ${i}` })),
    { content: `${MARK} far down` },
    ...Array.from({ length: 20 }, (_, i) => ({ content: `tail row ${i}` })),
  ])
  const target = ids[60] as string
  await waitIndexed(page, target)
  await submitSearch(page, MARK)
  await page.getByRole('option', { name: `${MARK} far down` }).click()

  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Projects')
  const row = page.locator(`[data-testid="sortable-block"][data-block-id="${target}"]`)
  await expect(row).toBeInViewport()
  await expect(row.locator('[data-testid="block-editor"] [contenteditable="true"]')).toBeFocused()
})

test.describe('Command palette actions @search', () => {
  async function runPaletteCommand(page: Page, name: string): Promise<void> {
    await page.getByTestId('header-search-button').click()
    await page.getByTestId('command-palette-input').fill(`>${name}`)
    await page.getByRole('option', { name }).click()
  }

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Toggle sidebar collapses the sidebar', async ({ page }) => {
    await runPaletteCommand(page, 'Toggle sidebar')
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
  })

  test('Keyboard shortcuts opens the quick reference', async ({ page }) => {
    await runPaletteCommand(page, 'Keyboard shortcuts')
    await expect(activeSheet(page).getByRole('heading', { name: 'Quick reference' })).toBeVisible()
  })
})
