import { expect, test, waitForBoot } from './helpers'

/**
 * #548: `AgendaResults` virtualizes its list with `@tanstack/react-virtual`.
 * The unit test (`AgendaResults.test.tsx`) mocks the virtualizer entirely
 * because jsdom has no scroll geometry, so *which* rows render at a given
 * offset — and that rows recycle on scroll — is only observable in a real
 * browser. These specs cover that gap.
 *
 * The agenda's default filter is `todo_state IN (TODO, DOING)`, so the seeded
 * items (`__addMockAgendaItems` creates TODO blocks with staggered due dates)
 * all show up. We seed far more items than fit the viewport so the rendered
 * DOM window must be a small slice of the total.
 */

const SEEDED = 60

async function openAgendaWithItems(page: import('@playwright/test').Page) {
  await waitForBoot(page)
  await page.evaluate((n) => {
    ;(window as unknown as { __addMockAgendaItems: (c: number) => string[] }).__addMockAgendaItems(
      n,
    )
  }, SEEDED)
  await page.getByRole('tab', { name: 'Agenda view' }).click()
  await expect(page.locator('[data-testid="agenda-view"]')).toBeVisible()
  // Wait until the virtualizer has rendered the first window of rows.
  await expect(page.locator('[data-testid="agenda-results-item"]').first()).toBeVisible()
}

/** The `data-index` values currently mounted for agenda item rows. */
async function renderedItemIndices(page: import('@playwright/test').Page): Promise<number[]> {
  return page.$$eval('[data-testid="agenda-results-item"]', (els) =>
    els.map((el) => Number(el.getAttribute('data-index'))).filter((n) => Number.isFinite(n)),
  )
}

test.describe('Agenda list virtualization (#548)', () => {
  test('renders only a windowed slice of a long list, not every item', async ({ page }) => {
    await openAgendaWithItems(page)

    // The spacer <ul> is sized for ALL rows, so its height dwarfs the viewport.
    const list = page.locator('.agenda-results-list')
    const listHeight = await list.evaluate((el) => (el as HTMLElement).offsetHeight)
    const viewportHeight = await page
      .locator('.agenda-results-scroll')
      .evaluate((el) => (el as HTMLElement).clientHeight)
    expect(listHeight).toBeGreaterThan(viewportHeight)

    // Only a window (viewport + overscan) of the 60 items is in the DOM.
    const rendered = await page.locator('[data-testid="agenda-results-item"]').count()
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(SEEDED)
  })

  test('recycles rows as the list scrolls: offscreen items unmount, new ones mount', async ({
    page,
  }) => {
    await openAgendaWithItems(page)

    const before = await renderedItemIndices(page)
    const minBefore = Math.min(...before)
    const maxBefore = Math.max(...before)
    // `data-index` spans both group-header and item rows, so the first item's
    // index is whatever the agenda's grouping puts ahead of it — assert on the
    // shift, not an absolute starting index.

    // Scroll the virtualizer's viewport to the bottom.
    const viewport = page.locator('.agenda-results-scroll')
    await viewport.evaluate((el) => {
      ;(el as HTMLElement).scrollTop = (el as HTMLElement).scrollHeight
    })

    // After scrolling, a higher index than anything visible before must now be
    // mounted (new rows appeared)...
    await expect
      .poll(async () => Math.max(...(await renderedItemIndices(page))))
      .toBeGreaterThan(maxBefore)

    // ...and the rows that were at the top must have unmounted (rows recycled,
    // not merely appended).
    const after = await renderedItemIndices(page)
    expect(Math.min(...after)).toBeGreaterThan(minBefore)
    expect(after).not.toContain(minBefore)
  })
})
