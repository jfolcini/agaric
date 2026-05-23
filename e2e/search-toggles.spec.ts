/**
 * E2E — PEND-58f search-view toggles (E2E-1) + invalid-regex inline error
 * (E2E-2).
 *
 * The web+mock harness has no real Rust FTS/regex pipeline, so "exercise the
 * toggles against the real backend" (the literal E2E-1 wording) is not
 * achievable here. Instead we assert the contract the UI is responsible for:
 *
 *   - clicking each toggle flips its `aria-pressed` + `data-state`;
 *   - the toggle state is reflected in the IPC payload (`filter.caseSensitive`
 *     / `wholeWord` / `isRegex`) the panel sends to `search_blocks`;
 *   - regex mode forwards the raw query verbatim and drops structured filter
 *     params (the regex-mode short-circuit in `SearchPanel.queryFn`);
 *   - an invalid regex surfaces inline (`search-inline-error`) and a
 *     non-regex backend error renders the visible error state (E2E-2).
 *
 * The IPC recorder (helpers `installIpcRecorder` / `getInvokeCalls`) wraps the
 * live mock `invoke` so we can read the filter flags the real backend would
 * receive.
 */

import {
  clearConsoleErrors,
  clearInvokeCalls,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  openSearchView,
  test,
} from './helpers'

interface MockErrorWindow extends Window {
  __injectMockError?: (command: string, message: string) => void
  __clearMockErrors?: () => void
}

/** Fire a query and wait until at least one `search_blocks` IPC is recorded. */
async function searchAndAwaitIpc(page: import('@playwright/test').Page, query: string) {
  await clearInvokeCalls(page)
  const input = page.getByPlaceholder('Search blocks...')
  await input.fill(query)
  await input.press('Enter')
  await expect
    .poll(async () => (await getInvokeCalls(page, 'search_blocks')).length)
    .toBeGreaterThan(0)
}

test.describe('Search toggles (PEND-58f E2E-1)', () => {
  test.beforeEach(async ({ page }) => {
    await openSearchView(page)
    await installIpcRecorder(page)
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
      // UX-15 — shape-only active dot renders when pressed.
      await expect(page.getByTestId(`${testId}-active-dot`)).toBeVisible()
      // Reset so toggles don't interact across the loop.
      await btn.click()
      await expect(btn).toHaveAttribute('aria-pressed', 'false')
    }
  })

  test('default search sends all-false filter flags', async ({ page }) => {
    await searchAndAwaitIpc(page, 'Welcome')
    const calls = await getInvokeCalls(page, 'search_blocks')
    const filter = calls[calls.length - 1]?.['filter'] as Record<string, unknown>
    expect(filter['caseSensitive']).toBe(false)
    expect(filter['wholeWord']).toBe(false)
    expect(filter['isRegex']).toBe(false)
  })

  test('case-sensitive toggle sets filter.caseSensitive on the IPC payload', async ({ page }) => {
    await page.getByTestId('search-toggle-case-sensitive').click()
    await searchAndAwaitIpc(page, 'Welcome')
    const calls = await getInvokeCalls(page, 'search_blocks')
    const filter = calls[calls.length - 1]?.['filter'] as Record<string, unknown>
    expect(filter['caseSensitive']).toBe(true)
    expect(filter['wholeWord']).toBe(false)
    expect(filter['isRegex']).toBe(false)
  })

  test('whole-word toggle sets filter.wholeWord on the IPC payload', async ({ page }) => {
    await page.getByTestId('search-toggle-whole-word').click()
    await searchAndAwaitIpc(page, 'Welcome')
    const calls = await getInvokeCalls(page, 'search_blocks')
    const filter = calls[calls.length - 1]?.['filter'] as Record<string, unknown>
    expect(filter['wholeWord']).toBe(true)
    expect(filter['caseSensitive']).toBe(false)
    expect(filter['isRegex']).toBe(false)
  })

  test('regex toggle forwards the raw query and drops structured filters', async ({ page }) => {
    await page.getByTestId('search-toggle-regex').click()
    // In regex mode the user's input is the regex verbatim — a `tag:` token
    // must NOT be parsed into `filter.tagIds`; the whole string is the pattern.
    await searchAndAwaitIpc(page, 'W.*come tag:#work')
    const calls = await getInvokeCalls(page, 'search_blocks')
    const last = calls[calls.length - 1]
    const filter = last?.['filter'] as Record<string, unknown>
    expect(filter['isRegex']).toBe(true)
    // Raw query forwarded verbatim (regex mode bypasses the AST free-text split).
    expect(last?.['query']).toBe('W.*come tag:#work')
    // Structured filter params are empty in regex mode.
    expect(filter['tagIds']).toEqual([])
    expect(filter['stateFilter']).toEqual([])
  })
})

test.describe('Search backend-error surface (PEND-58f E2E-2)', () => {
  test.afterEach(async ({ page }) => {
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__clearMockErrors?.()
    })
    // The injected backend failure flows through logger.error → console.error;
    // clear the captured buffer so the global no-console-errors gate passes
    // (documented opt-out in helpers.ts).
    clearConsoleErrors(page)
  })

  // E2E-2 — an invalid regex surfaces inline. The raw `InvalidRegex:` IPC
  // message now reaches the panel (SearchPanel no longer passes `onError`
  // to usePaginatedQuery, which used to overwrite the raw message), so the
  // `regexError` parser lights up `search-inline-error` and the body
  // error-state is suppressed.
  test('invalid regex shows the inline error (search-inline-error)', async ({ page }) => {
    await openSearchView(page)
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'search_blocks',
        'InvalidRegex: unclosed group at position 0',
      )
    })

    await page.getByTestId('search-toggle-regex').click()
    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('(unclosed')
    await input.press('Enter')

    const inlineError = page.getByTestId('search-inline-error')
    await expect(inlineError).toBeVisible()
    await expect(inlineError).toContainText('unclosed group')
    // The inline regex error owns the failure; the body error-state stays out.
    await expect(page.getByTestId('search-error-state')).toHaveCount(0)
  })

  test('a non-regex backend error renders a visible error state (UX-2)', async ({ page }) => {
    await openSearchView(page)
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'search_blocks',
        'database is locked',
      )
    })

    const input = page.getByPlaceholder('Search blocks...')
    await input.fill('anything')
    await input.press('Enter')

    // UX-2 — generic (non-regex) failures previously left the panel blank;
    // they now render a visible, role="alert" error state.
    const errorState = page.getByTestId('search-error-state')
    await expect(errorState).toBeVisible()
    await expect(errorState).toHaveAttribute('role', 'alert')
  })
})
