/**
 * E2E — search happy paths (#5738): Enter commits a search without waiting
 * for the debounce, a result click opens its page with the block scrolled
 * into view and focused, and the palette's Toggle sidebar and Keyboard
 * shortcuts entries. Each step is one mock IPC or none, so the mock lane shows
 * every failure.
 */

import type { Page } from '@playwright/test'

import {
  activeSheet,
  expect,
  openSearchView,
  searchResultIds,
  seedSearchBlocks,
  submitSearch,
  test,
  waitForBoot,
} from './helpers'

const MARK = 'quokka'

test('Enter runs the search without waiting for the debounce', async ({ page }) => {
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

test('clicking a result opens its page with the block in view and focused', async ({ page }) => {
  await openSearchView(page)
  // Far past the tree's initial render window, so the row starts below the fold.
  const ids = await seedSearchBlocks(page, [
    ...Array.from({ length: 60 }, (_, i) => ({ content: `filler row ${i}` })),
    { content: `${MARK} far down` },
    ...Array.from({ length: 20 }, (_, i) => ({ content: `tail row ${i}` })),
  ])
  const target = ids[60] as string
  await submitSearch(page, MARK)
  await page.getByRole('option', { name: `${MARK} far down` }).click()

  await expect(page.locator('[aria-label="Page title"]')).toHaveText('Projects')
  const row = page.locator(`[data-testid="sortable-block"][data-block-id="${target}"]`)
  await expect(row).toBeInViewport()
  await expect(row.locator('[data-testid="block-editor"] [contenteditable="true"]')).toBeFocused()
})

test.describe('Command palette actions', () => {
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
    await expect(activeSheet(page).getByRole('heading', { name: 'Quick Reference' })).toBeVisible()
  })
})
