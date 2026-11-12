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
 * Find searches the page's block text, not the chrome around it (#6557), so
 * the case-insensitive substring "block" turns up 3 times: "blocks"+"block"
 * in GS_3 and "blocks" in GS_4. The "Add block" button below the tree and the
 * "Block refs" toggle in Linked References do not count.
 */
import { emitMockEvent, expect, ipc, openPage, test, waitForBoot } from './helpers'

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

/** The text of the current-match highlight's ranges. */
function currentMatchText(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const highlight = (
      window.CSS as unknown as { highlights?: Map<string, Iterable<Range>> }
    ).highlights?.get('find-match-current')
    return highlight ? [...highlight].map((range) => range.toString()).join('|') : ''
  })
}

async function openFind(page: import('@playwright/test').Page) {
  await page.keyboard.down('Control')
  await page.keyboard.press('f')
  await page.keyboard.up('Control')
  const toolbar = page.getByRole('toolbar', { name: /find/i })
  await expect(toolbar).toBeVisible()
  return toolbar
}

test.describe('In-page find (Ctrl+F) @pages @search', () => {
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

    // 3 case-insensitive matches in block text (see the header).
    await expect(counter).toHaveText('1 of 3')

    // The matcher paints via `CSS.highlights`. `paint()`
    // (`src/lib/in-page-find/highlighter.ts`) pulls the ACTIVE match out of
    // `find-match` into its own `find-match-current` overlay rather than
    // double-painting it, so of the 3 total matches, 2 land in `find-match`
    // and exactly 1 (the active one) lands in `find-match-current`.
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(2)
    await expect.poll(() => highlightSize(page, 'find-match-current')).toBe(1)
  })

  test('next/previous navigation moves the active match and wraps', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    const counter = page.getByTestId('in-page-find-counter')
    const next = page.getByTestId('in-page-find-next')
    const previous = page.getByTestId('in-page-find-previous')

    await input.fill('block')
    await expect(counter).toHaveText('1 of 3')

    await next.click()
    await expect(counter).toHaveText('2 of 3')
    await next.click()
    await expect(counter).toHaveText('3 of 3')
    // Next from the last match wraps back to the first.
    await next.click()
    await expect(counter).toHaveText('1 of 3')

    // Previous from the first match wraps to the last.
    await previous.click()
    await expect(counter).toHaveText('3 of 3')
    await previous.click()
    await expect(counter).toHaveText('2 of 3')

    // The "current" highlight always stays a singleton as the index moves;
    // `find-match` holds the other 2 (see the painting note above).
    await expect.poll(() => highlightSize(page, 'find-match-current')).toBe(1)
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(2)
  })

  test('Enter/Shift+Enter in the input also cycle matches', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    const counter = page.getByTestId('in-page-find-counter')

    await input.fill('block')
    await expect(counter).toHaveText('1 of 3')

    await input.press('Enter')
    await expect(counter).toHaveText('2 of 3')

    await input.press('Shift+Enter')
    await expect(counter).toHaveText('1 of 3')
  })

  test('Escape closes the toolbar and clears highlights', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    await input.fill('block')
    await expect(page.getByTestId('in-page-find-counter')).toHaveText('1 of 3')
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(2)

    await input.press('Escape')

    await expect(page.getByRole('toolbar', { name: /find/i })).toBeHidden()
    // Closing tears down the matcher effect, which clears the registry.
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(0)
    await expect.poll(() => highlightSize(page, 'find-match-current')).toBe(0)
  })

  test('the close button also closes the toolbar and clears highlights', async ({ page }) => {
    await openFind(page)
    await page.getByTestId('in-page-find-input').fill('block')
    await expect(page.getByTestId('in-page-find-counter')).toHaveText('1 of 3')

    await page.getByTestId('in-page-find-close').click()

    await expect(page.getByRole('toolbar', { name: /find/i })).toBeHidden()
    await expect.poll(() => highlightSize(page, 'find-match')).toBe(0)
  })
})

/**
 * #6557 — find matches the page store's block text, not the DOM, so rows the
 * viewport paints as placeholders, rows past the mount cap and children of a
 * collapsed block all count, and chrome around the blocks does not.
 */
const LONG_PAGE = 'Find Long Page'
const LONG_PAGE_ROWS = 200

async function seedLongPage(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(
    async ({ title, rows }) => {
      const internals = (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] as {
        invoke: (cmd: string, args: unknown) => Promise<unknown>
      }
      const invoke = (cmd: string, args: Record<string, unknown>) => internals.invoke(cmd, args)
      const pageId = await invoke('create_page_in_space', {
        parentId: null,
        content: title,
        spaceId: 'SPACE_PERSONAL',
      })
      // `needle` in every fifth row, the last one included: 40 rows.
      const content = (i: number): string => {
        if (i === 1) return '**bold**tail'
        if (i === rows - 1) return `row ${i} needle zebraquartz`
        return `row ${i}${i % 5 === 4 ? ' needle' : ''}`
      }
      const created = (await invoke('create_blocks_batch', {
        specs: Array.from({ length: rows }, (_, i) => ({
          blockType: 'content',
          content: content(i),
          parentId: pageId,
          position: null,
        })),
      })) as { blocks: Array<{ id: string }> }
      await invoke('create_blocks_batch', {
        specs: [
          {
            blockType: 'content',
            content: 'hiddenchild',
            parentId: created.blocks[2]?.id,
            position: null,
          },
        ],
      })
      return pageId as string
    },
    { title: LONG_PAGE, rows: LONG_PAGE_ROWS },
  )
}

test.describe('In-page find on a long page @pages @search', () => {
  let pageId = ''
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
    pageId = await seedLongPage(page)
    await openPage(page, LONG_PAGE)
  })

  test('counts every row and reaches the last one', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    const counter = page.getByTestId('in-page-find-counter')

    await input.fill('needle')
    await expect(counter).toHaveText('1 of 40')

    // Previous from the first match wraps to the last row's match.
    await input.press('Shift+Enter')
    await expect(counter).toHaveText('40 of 40')
    const lastRow = page.locator('li[data-block-id]').filter({ hasText: 'zebraquartz' })
    await expect(lastRow).toBeInViewport()
    await expect.poll(() => highlightSize(page, 'find-match-current')).toBe(1)

    // A phrase only the last row holds.
    await input.fill('zebraquartz')
    await expect(counter).toHaveText('1 of 1')
    await expect(lastRow).toBeInViewport()
    await expect.poll(() => currentMatchText(page)).toBe('zebraquartz')
  })

  test('matches across a mark boundary and never matches chrome', async ({ page }) => {
    await openFind(page)
    const input = page.getByTestId('in-page-find-input')
    const counter = page.getByTestId('in-page-find-counter')

    // The "Add block" button below the tree is chrome.
    await input.fill('Add block')
    await expect(counter).toHaveText('0 of 0')

    await input.fill('boldtail')
    await expect(counter).toHaveText('1 of 1')
    await expect.poll(() => currentMatchText(page)).toBe('boldtail')
  })

  test('counts a match under a collapsed block and expands it on navigate', async ({ page }) => {
    const parentRow = page.locator('li[data-block-id]').filter({ hasText: /^row 2$/ })
    const chevron = parentRow.getByTestId('collapse-toggle')
    await parentRow.hover()
    await chevron.click()
    await expect(chevron).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('hiddenchild')).toHaveCount(0)

    await openFind(page)
    await page.getByTestId('in-page-find-input').fill('hiddenchild')
    await expect(page.getByTestId('in-page-find-counter')).toHaveText('1 of 1')
    await expect(page.getByText('hiddenchild')).toBeInViewport()
    await expect.poll(() => currentMatchText(page)).toBe('hiddenchild')
  })

  test('the count follows a block edit while the bar is open', async ({ page }) => {
    await openFind(page)
    const counter = page.getByTestId('in-page-find-counter')
    await page.getByTestId('in-page-find-input').fill('zebraquartz')
    await expect(counter).toHaveText('1 of 1')

    // A peer's edit, so the bar keeps focus and nothing but the page store changes.
    const lastRow = page.locator('li[data-block-id]').filter({ hasText: 'zebraquartz' })
    const blockId = await lastRow.getAttribute('data-block-id')
    await ipc(page, 'edit_block', { blockId, toText: 'zebraquartz and zebraquartz' })
    await emitMockEvent(page, 'sync:complete', {
      type: 'complete',
      remote_device_id: 'device-b',
      ops_received: 1,
      ops_sent: 0,
      changed_blocks: 1,
      changed_page_ids: [pageId],
    })
    await expect(counter).toHaveText('1 of 2')
  })
})
