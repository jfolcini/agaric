import { expect, test, waitForBoot } from './helpers'

/**
 * #1415 — Continuous infinite-scroll journal stream (Logseq-style).
 *
 * The stream renders a single chronological column of daily date pages,
 * today pinned at the top, older days appended below as the user scrolls
 * toward the bottom. The window starts at STREAM_INITIAL_DAYS days and grows
 * by STREAM_BATCH_DAYS each time the bottom sentinel nears the viewport.
 *
 * jsdom has no scroll geometry, so the unit test mocks the IntersectionObserver
 * to prove the loadOlder wiring; this spec exercises the real scroll-loads-older
 * behaviour in a browser, plus the virtualization contract (off-window days do
 * not mount a BlockTree editor).
 */

/** Count the day-section panels currently in the stream. */
async function dayCount(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('[data-testid="journal-stream"] section[id^="journal-"]').count()
}

/** Scroll the stream's nearest scrollable ancestor to the bottom. */
async function scrollStreamToBottom(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="journal-stream"]').evaluate((el) => {
    let node: HTMLElement | null = el as HTMLElement
    while (node) {
      const style = getComputedStyle(node)
      const scrollable =
        (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight
      if (scrollable) {
        node.scrollTop = node.scrollHeight
        return
      }
      node = node.parentElement
    }
    // Fall back to the document scroller.
    window.scrollTo(0, document.body.scrollHeight)
  })
}

test.describe('Continuous infinite-scroll journal (#1415)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await waitForBoot(page)
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('tab', { name: 'Continuous stream view' }).click()
    await expect(page.locator('[data-testid="journal-stream"]')).toBeVisible()
  })

  test('anchors today at the top of the stream', async ({ page }) => {
    const todayIso = new Date().toLocaleDateString('en-CA') // YYYY-MM-DD (local)
    const firstSection = page
      .locator('[data-testid="journal-stream"] section[id^="journal-"]')
      .first()
    await expect(firstSection).toHaveAttribute('id', `journal-${todayIso}`)
  })

  test('scrolling toward the bottom loads older days', async ({ page }) => {
    const before = await dayCount(page)
    expect(before).toBeGreaterThan(0)

    await scrollStreamToBottom(page)

    // The bottom sentinel (rootMargin 600px) triggers loadOlder, revealing a
    // new batch of older day sections below the previous oldest.
    await expect.poll(() => dayCount(page)).toBeGreaterThan(before)
  })

  test('does not mount a BlockTree editor for every loaded day (virtualized)', async ({ page }) => {
    // Grow the window so there are many more loaded days than fit the viewport.
    await scrollStreamToBottom(page)
    await expect.poll(() => dayCount(page)).toBeGreaterThan(14)

    const loaded = await dayCount(page)
    // Lazy mount: a day's editor only mounts once it enters the viewport, so
    // the number of mounted editors must be a small slice of the loaded days,
    // never one-per-day.
    const editors = await page.getByRole('textbox', { name: 'Block editor' }).count()
    expect(editors).toBeLessThan(loaded)
  })
})
