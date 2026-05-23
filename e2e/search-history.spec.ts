/**
 * E2E — PEND-58f search history (E2E-5).
 *
 * The focus/caret/mousedown interplay around the history dropdown is
 * browser-specific and only surfaces against a real DOM, so it's the highest-
 * value bit to drive end-to-end. Covers: submit builds history, the dropdown
 * shows on focus+empty, ↑/↓ recall, pick fills+submits, per-row delete,
 * disable/enable toggle, and clear.
 *
 * History persists to `localStorage['agaric:search-history']`. Each Playwright
 * test gets a fresh context (storageState only seeds onboarding), so history
 * starts empty per test — no cross-test bleed.
 */

import { expect, openSearchView, test } from './helpers'

/** Submit a query (history pushes on submit, not on keystroke). */
async function submit(page: import('@playwright/test').Page, query: string) {
  const input = page.getByPlaceholder('Search blocks...')
  await input.fill(query)
  await input.press('Enter')
}

/** localStorage key the search-history store persists under (zustand persist). */
const HISTORY_STORAGE_KEY = 'agaric:search-history'

/**
 * Pre-boot seed of the persisted per-space history. Mirrors zustand's
 * `persist` envelope (`{ state, version }`); `version: 0` (< the store's
 * `version: 1`) guarantees the store's `migrate` runs `coerceBySpace` on
 * the seeded `bySpace` — the same read path production uses. Must be
 * registered BEFORE `waitForBoot`/`openSearchView` so it lands before the
 * store hydrates.
 */
async function seedHistory(
  page: import('@playwright/test').Page,
  bySpace: Record<string, string[]>,
) {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, value)
    },
    {
      key: HISTORY_STORAGE_KEY,
      value: JSON.stringify({ state: { bySpace, historyEnabled: true }, version: 0 }),
    },
  )
}

/** Read back the persisted `bySpace` map from localStorage. */
function readPersistedBySpace(
  page: import('@playwright/test').Page,
): Promise<Record<string, string[]>> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { state?: { bySpace?: Record<string, string[]> } }
    return parsed.state?.bySpace ?? {}
  }, HISTORY_STORAGE_KEY)
}

/** Clear the input while focused so the empty+focused history dropdown opens. */
async function openHistoryDropdown(page: import('@playwright/test').Page) {
  const input = page.getByPlaceholder('Search blocks...')
  await input.click()
  await input.fill('')
  const dropdown = page.getByTestId('search-history-dropdown')
  await expect(dropdown).toBeVisible()
  return dropdown
}

test.describe('Search history (PEND-58f E2E-5)', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
  })

  test('submitting builds the history list and the dropdown shows it', async ({ page }) => {
    await submit(page, 'alpha')
    await submit(page, 'beta')
    const dropdown = await openHistoryDropdown(page)
    // MRU order — newest first.
    await expect(dropdown.getByTestId('search-history-entry-0')).toHaveText(/beta/)
    await expect(dropdown.getByTestId('search-history-entry-1')).toHaveText(/alpha/)
  })

  test('ArrowUp / ArrowDown recall walks the MRU list', async ({ page }) => {
    await submit(page, 'alpha')
    await submit(page, 'beta')
    const input = page.getByPlaceholder('Search blocks...')
    await input.click()
    await input.fill('')
    await expect(page.getByTestId('search-history-dropdown')).toBeVisible()

    // First ArrowUp → most-recent entry ('beta').
    await input.press('ArrowUp')
    await expect(input).toHaveValue('beta')
    // Second ArrowUp → older entry ('alpha').
    await input.press('ArrowUp')
    await expect(input).toHaveValue('alpha')
    // ArrowDown → back toward newest ('beta').
    await input.press('ArrowDown')
    await expect(input).toHaveValue('beta')
    // ArrowDown past the newest → clears the input.
    await input.press('ArrowDown')
    await expect(input).toHaveValue('')
  })

  test('clicking a history row fills the input and re-submits', async ({ page }) => {
    await submit(page, 'searchterm')
    const dropdown = await openHistoryDropdown(page)
    await dropdown.getByTestId('search-history-entry-0').click()
    const input = page.getByPlaceholder('Search blocks...')
    await expect(input).toHaveValue('searchterm')
  })

  test('per-row delete removes a single entry', async ({ page }) => {
    await submit(page, 'keep-me')
    await submit(page, 'delete-me')
    const dropdown = await openHistoryDropdown(page)
    await expect(dropdown.getByTestId('search-history-entry-0')).toHaveText(/delete-me/)
    // The remove affordance for the newest row (index 0).
    await dropdown.getByTestId('search-history-remove-0').click()
    // 'delete-me' gone; 'keep-me' is now the only (newest) entry.
    await expect(dropdown.getByTestId('search-history-entry-0')).toHaveText(/keep-me/)
    await expect(dropdown.getByTestId('search-history-entry-1')).toHaveCount(0)
  })

  test('disable toggle stops recording new submissions; enable resumes', async ({ page }) => {
    await submit(page, 'before-disable')
    let dropdown = await openHistoryDropdown(page)

    // Disable recording.
    await dropdown.getByTestId('search-history-toggle').click()
    await expect(dropdown.getByTestId('search-history-disabled-notice')).toBeVisible()

    // A new submission is NOT recorded while disabled.
    await submit(page, 'while-disabled')
    dropdown = await openHistoryDropdown(page)
    await expect(dropdown).not.toContainText('while-disabled')
    await expect(dropdown.getByTestId('search-history-entry-0')).toHaveText(/before-disable/)

    // Re-enable; the notice disappears.
    await dropdown.getByTestId('search-history-toggle').click()
    await expect(page.getByTestId('search-history-disabled-notice')).toHaveCount(0)

    // New submissions record again.
    await submit(page, 'after-enable')
    dropdown = await openHistoryDropdown(page)
    await expect(dropdown.getByTestId('search-history-entry-0')).toHaveText(/after-enable/)
  })

  test('clear wipes the per-space history', async ({ page }) => {
    await submit(page, 'one')
    await submit(page, 'two')
    const dropdown = await openHistoryDropdown(page)
    await expect(dropdown.getByTestId('search-history-entry-0')).toBeVisible()

    await dropdown.getByTestId('search-history-clear').click()
    // After clear there are zero entries and recording is still enabled, so
    // the dropdown's visibility gate (`entries.length > 0 || !historyEnabled`)
    // is false — the whole dropdown unmounts. No history rows remain.
    await expect(page.getByTestId('search-history-dropdown')).toHaveCount(0)
    await expect(page.getByTestId('search-history-entry-0')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// E2E-A10 — history is space-scoped.
//
// `useSearchHistoryStore` partitions submissions by `currentSpaceId`
// (`bySpace[spaceKey(spaceId)]`); the dropdown only ever renders the active
// space's list via `selectHistoryForSpace` (see `src/stores/search-history.ts`).
//
// The web+mock harness hardcodes `list_spaces` to a single space
// (`SPACE_PERSONAL`), so the in-app SpaceSwitcher can't switch to a second
// space here. We instead pre-seed a FOREIGN space's history into the
// persisted store before boot and assert the active space is isolated from
// it: the foreign entry never surfaces in the active-space dropdown, and a
// new submission lands under the active space while the foreign space's list
// stays untouched. This drives the real per-space keying contract end-to-end
// (store hydration → `coerceBySpace` → `selectHistoryForSpace` → dropdown).
//
// Has its own describe (no shared `openSearchView` beforeEach): the seed
// must be installed via `addInitScript` BEFORE boot so it lands before the
// store hydrates.
// ---------------------------------------------------------------------------
test.describe('Search history — per-space isolation (PEND-58g E2E-A10)', () => {
  const FOREIGN_SPACE = 'SPACE_OTHER'
  const FOREIGN_ENTRY = 'foreign-space-query'

  test("a foreign space's history is hidden and the active space keeps its own", async ({
    page,
  }) => {
    // Pre-seed history under a DIFFERENT space than the active one.
    await seedHistory(page, { [FOREIGN_SPACE]: [FOREIGN_ENTRY] })
    await openSearchView(page)

    // Submit in the active space (SPACE_PERSONAL — the only seeded space).
    await submit(page, 'active-space-query')

    // The active-space dropdown shows ONLY the active space's entry; the
    // foreign space's entry is partitioned out and never appears.
    const dropdown = await openHistoryDropdown(page)
    await expect(dropdown.getByTestId('search-history-entry-0')).toHaveText(/active-space-query/)
    await expect(dropdown).not.toContainText(FOREIGN_ENTRY)
    // Exactly one row renders (the foreign entry is not merged in).
    await expect(dropdown.getByTestId('search-history-entry-1')).toHaveCount(0)

    // The persisted store keeps each space's list independent: the foreign
    // space's MRU is untouched, and the new submission landed under a
    // separate (active-space) key.
    const bySpace = await readPersistedBySpace(page)
    expect(bySpace[FOREIGN_SPACE]).toEqual([FOREIGN_ENTRY])
    const activeKeys = Object.keys(bySpace).filter((k) => k !== FOREIGN_SPACE)
    expect(activeKeys).toHaveLength(1)
    const activeKey = activeKeys[0] as string
    expect(activeKey).not.toBe(FOREIGN_SPACE)
    expect(bySpace[activeKey]).toEqual(['active-space-query'])
  })
})
