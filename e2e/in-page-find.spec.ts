/**
 * E2E for in-page find (Ctrl+F) — #2710.
 *
 * `e2e/keyboard-shortcuts.spec.ts` only asserts the toolbar becomes visible
 * after Ctrl+F. This spec covers the rest of the interaction surface: typing
 * a query that has multiple matches, the match counter, next/previous
 * navigation (including wraparound), that matches are actually painted via
 * the CSS Custom Highlight registry (`CSS.highlights` — real in Chromium,
 * see `src/lib/in-page-find/highlighter.ts`), and Escape closing the bar and
 * clearing highlights.
 *
 * Seed data (`src/lib/tauri-mock/seed.ts`) — "Getting Started" page:
 *   GS_1 "Welcome to Agaric! This is your personal knowledge base."
 *   GS_2 "Use the sidebar to navigate between pages, tags, and search. See
 *        [[Quick Notes]] for tips."
 *   GS_3 "Create new blocks by pressing Enter at the end of any block."
 *   GS_4 "Try tagging blocks with #[work] or #[personal] to organize your
 *        notes."
 *   GS_5 "**Use the search panel** to find anything across all your pages."
 *
 * The find container is `PageEditor`'s root (`src/components/pages/
 * PageEditor.tsx`'s `pageRef`), which wraps the whole page surface — not
 * just block content — so the case-insensitive substring "block" turns up 4
 * times: "blocks"+"block" in GS_3, "blocks" in GS_4, and the "Add block"
 * button (`t('action.addBlock')`, `AddBlockButton.tsx`) rendered below the
 * block tree. That gives a small, deterministic, multi-match fixture
 * without any new seed data — confirmed empirically against the running
 * app rather than assumed from reading the seed content alone.
 */
import { expect, openPage, test, waitForBoot } from './helpers'

declare global {
  interface Window {
    CSS: typeof CSS & {
      highlights?: { get(name: string): { size: number } | undefined }
    }
  }
}

/** Read the live size of a named CSS Custom Highlight (0 when unset). */
function highlightSize(page: import('@playwright/test').Page, name: string): Promise<number> {
  return page.evaluate((n) => window.CSS.highlights?.get(n)?.size ?? 0, name)
}

async function openFind(page: import('@playwright/test').Page) {
  await page.keyboard.down('Control')
  await page.keyboard.press('f')
  await page.keyboard.up('Control')
  const toolbar = page.getByRole('toolbar', { name: /find/i })
  await expect(toolbar).toBeVisible()
  return toolbar
}

test.describe('In-page find (Ctrl+F)', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    await openPage(page, 'Getting Started')
  })

  test('typing a multi-match query updates the counter and paints highlights', async ({ page }) => {
    await openFind(page)

    const input = page.getByTestId('in-page-find-input')
    await expect(input).toBeFocused()
    const counter = page.getByTestId('in-page-find-counter')

    // Empty query → the empty-state counter, no highlights.
    await expect(counter).toHaveText('0 of 0')

    await input.fill('block')

    // 4 case-insensitive matches ("blocks"+"block" in GS_3, "blocks" in
    // GS_4, and the "Add block" button below the block tree).
    await expect(counter).toHaveText('1 of 4')

    // The matcher paints via `CSS.highlights`. `paint()`
    // (`src/lib/in-page-find/highlighter.ts`) pulls the ACTIVE match out of
    // `find-match` into its own `find-match-current` overlay rather than
    // double-painting it, so of the 4 total matches, 3 land in `find-match`
    // and exactly 1 (the active one) lands in `find-match-current`.
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(3)
    await expect.poll(() => highlightSize(page, 'find-match-current')).toBe(1)
  })

  test('next/previous navigation moves the active match and wraps', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    const counter = page.getByTestId('in-page-find-counter')
    const next = page.getByTestId('in-page-find-next')
    const previous = page.getByTestId('in-page-find-previous')

    await input.fill('block')
    await expect(counter).toHaveText('1 of 4')

    await next.click()
    await expect(counter).toHaveText('2 of 4')
    await next.click()
    await expect(counter).toHaveText('3 of 4')
    await next.click()
    await expect(counter).toHaveText('4 of 4')
    // Next from the last match wraps back to the first.
    await next.click()
    await expect(counter).toHaveText('1 of 4')

    // Previous from the first match wraps to the last.
    await previous.click()
    await expect(counter).toHaveText('4 of 4')
    await previous.click()
    await expect(counter).toHaveText('3 of 4')

    // The "current" highlight always stays a singleton as the index moves;
    // `find-match` holds the other 3 (see the painting note above).
    await expect.poll(() => highlightSize(page, 'find-match-current')).toBe(1)
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(3)
  })

  test('Enter/Shift+Enter in the input also cycle matches', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    const counter = page.getByTestId('in-page-find-counter')

    await input.fill('block')
    await expect(counter).toHaveText('1 of 4')

    await input.press('Enter')
    await expect(counter).toHaveText('2 of 4')

    await input.press('Shift+Enter')
    await expect(counter).toHaveText('1 of 4')
  })

  test('Escape closes the toolbar and clears highlights', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    await input.fill('block')
    await expect(page.getByTestId('in-page-find-counter')).toHaveText('1 of 4')
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(3)

    await input.press('Escape')

    await expect(page.getByRole('toolbar', { name: /find/i })).toBeHidden()
    // Closing tears down the matcher effect, which clears the registry.
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(0)
    await expect.poll(() => highlightSize(page, 'find-match-current')).toBe(0)
  })

  test('the close button also closes the toolbar and clears highlights', async ({ page }) => {
    await openFind(page)
    await page.getByTestId('in-page-find-input').fill('block')
    await expect(page.getByTestId('in-page-find-counter')).toHaveText('1 of 4')

    await page.getByTestId('in-page-find-close').click()

    await expect(page.getByRole('toolbar', { name: /find/i })).toBeHidden()
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(0)
  })
})
