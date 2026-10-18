/**
 * E2E — search-view toggles (E2E-1) + invalid-regex inline error
 * (E2E-2).
 *
 *   - clicking each toggle flips its `aria-pressed` + `data-state`;
 *   - each toggle changes which seeded blocks the results render;
 *   - regex mode is symmetric with normal mode (cluster-1): structured tokens
 *     are parsed out and applied as filters, only the free-text remainder is
 *     the regex pattern;
 *   - an invalid regex surfaces inline (`search-inline-error`) and a
 *     non-regex backend error renders the visible error state (E2E-2).
 */

import {
  clearConsoleErrors,
  expect,
  openSearchView,
  searchResultIds,
  seedSearchBlocks,
  submitSearch,
  test,
} from './helpers'

interface MockErrorWindow extends Window {
  __injectMockError?: (
    command: string,
    error: string | { kind: string; message: string; code?: string },
  ) => void
  __clearMockErrors?: () => void
}

test.describe('Search toggles (E2E-1) @search', () => {
  /** Capitalised, lower-case TODO, and a longer word: each toggle drops a different one. */
  let capitalised: string
  let lowerTodo: string
  let longerWord: string

  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
    ;[capitalised, lowerTodo, longerWord] = (await seedSearchBlocks(page, [
      { content: 'Quokka zone' },
      { content: 'a quokka here', todo: 'TODO' },
      { content: 'quokkas everywhere' },
    ])) as [string, string, string]
  })

  test('case / word / regex toggles flip aria-pressed and data-state', async ({ page }) => {
    const toggleRow = page.getByTestId('search-toggle-row')
    await expect(toggleRow).toHaveAttribute('role', 'toolbar')

    for (const testId of [
      'search-toggle-case-sensitive',
      'search-toggle-whole-word',
      'search-toggle-regex',
    ]) {
      const btn = page.getByTestId(testId)
      await expect(btn).toHaveAttribute('aria-pressed', 'false')
      await expect(btn).toHaveAttribute('data-state', 'off')
      await btn.click()
      await expect(btn).toHaveAttribute('aria-pressed', 'true')
      await expect(btn).toHaveAttribute('data-state', 'on')
      // Shape-only active dot renders when pressed.
      await expect(page.getByTestId(`${testId}-active-dot`)).toBeVisible()
      // Reset so toggles don't interact across the loop.
      await btn.click()
      await expect(btn).toHaveAttribute('aria-pressed', 'false')
    }
  })

  test('default search folds case and matches inside words', async ({ page }) => {
    await submitSearch(page, 'quokka')
    await expect
      .poll(() => searchResultIds(page))
      .toEqual([capitalised, lowerTodo, longerWord].toSorted())
  })

  test('case-sensitive toggle drops a differently cased match', async ({ page }) => {
    await page.getByTestId('search-toggle-case-sensitive').click()
    await submitSearch(page, 'quokka')
    await expect.poll(() => searchResultIds(page)).toEqual([lowerTodo, longerWord].toSorted())
  })

  test('whole-word toggle drops a match inside a longer word', async ({ page }) => {
    await page.getByTestId('search-toggle-whole-word').click()
    await submitSearch(page, 'quokka')
    await expect.poll(() => searchResultIds(page)).toEqual([capitalised, lowerTodo].toSorted())
  })

  test('regex mode parses structured filters out of the pattern (symmetric with normal mode)', async ({
    page,
  }) => {
    await page.getByTestId('search-toggle-regex').click()
    // Cluster-1 — regex mode is SYMMETRIC with normal mode: `state:TODO` is
    // applied as a filter and only `qu.kka` is the pattern. No block holds the
    // literal text `qu.kka`, so a hit proves the pattern ran as a regex.
    await submitSearch(page, 'qu.kka state:TODO')
    await expect.poll(() => searchResultIds(page)).toEqual([lowerTodo])
  })
})

test.describe('Search backend-error surface (E2E-2) @search', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__clearMockErrors?.()
    })
    // The injected backend failure flows through logger.error → console.error;
    // clear the captured buffer so the global no-console-errors gate passes
    // (documented opt-out in helpers.ts).
    clearConsoleErrors(page)
  })

  // E2E-2 / #2251 — an invalid regex surfaces inline. The injection is the
  // structured `{ kind: 'validation', code: 'InvalidRegex' }` wire object a
  // real backend rejection carries, so the panel's code-discriminated
  // `regexError` lights up `search-inline-error` and the body error-state
  // is suppressed.
  test('invalid regex shows the inline error (search-inline-error)', async ({ page }) => {
    await openSearchView(page)
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.('search_blocks', {
        kind: 'validation',
        code: 'InvalidRegex',
        message: 'unclosed group at position 0',
      })
    })

    await page.getByTestId('search-toggle-regex').click()
    const input = page.getByRole('combobox', { name: 'Search blocks' })
    await input.fill('(unclosed')
    await input.press('Enter')

    const inlineError = page.getByTestId('search-inline-error')
    await expect(inlineError).toBeVisible()
    await expect(inlineError).toContainText('unclosed group')
    // The inline regex error owns the failure; the body error-state stays out.
    await expect(page.getByTestId('search-error-state')).toHaveCount(0)
  })

  test('a non-regex backend error renders a visible error state', async ({ page }) => {
    await openSearchView(page)
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'search_blocks',
        'database is locked',
      )
    })

    const input = page.getByRole('combobox', { name: 'Search blocks' })
    await input.fill('anything')
    await input.press('Enter')

    // Generic (non-regex) failures previously left the panel blank;
    // they now render a visible, role="alert" error state.
    const errorState = page.getByTestId('search-error-state')
    await expect(errorState).toBeVisible()
    await expect(errorState).toHaveAttribute('role', 'alert')
  })
})
