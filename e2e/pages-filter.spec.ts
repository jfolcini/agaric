import { expect, test, waitForBoot } from './helpers'

/**
 * E2E coverage for PEND-58 — Pages-view compound-filter chip-row.
 *
 * The chip-row is gated behind the `pageBrowser.densityV1` localStorage
 * flag, which the app reads once at mount. We register an init script
 * BEFORE `waitForBoot`'s `page.goto('/')` so the flag is set before the
 * app boots.
 *
 * NOTE on facet choice: the tauri-mock (`src/lib/tauri-mock/handlers.ts`)
 * does NOT model the `block_links` table, so `Orphan` /
 * `HasNoInboundLinks` are no-ops in the mock (every page reports zero
 * inbound links). The `Stub` facet keys on `childBlockCount`, which the
 * mock DOES compute from seeded descendants, so it is the meaningful
 * facet to exercise here. This test asserts the real-browser UI flow
 * (filter row renders, popover adds a chip, chip removes); it does not
 * assert exact result-set narrowing because the mock's seed mix is not
 * pinned by this spec.
 */

async function openPagesView(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  await expect(page.getByRole('grid')).toBeVisible()
}

test.describe('PEND-58 — Pages compound-filter chip-row', () => {
  test('adds a Stub filter chip via the Add-Filter popover and removes it', async ({ page }) => {
    // Set the flag BEFORE boot so the app reads it at mount. `addInitScript`
    // applies to the `page.goto('/')` inside `waitForBoot`.
    await page.addInitScript(() => {
      window.localStorage.setItem('pageBrowser.densityV1', 'true')
    })
    await waitForBoot(page)
    await openPagesView(page)

    // The filter row renders on the densityV1 path.
    const addFilter = page.getByRole('button', { name: 'Add filter' })
    await expect(addFilter).toBeVisible()

    // Open the popover and pick the Pages-only "Stub" facet.
    await addFilter.click()
    await page.getByText('Stub', { exact: true }).click()

    // A chip renders for the active filter. (The chip row stays mounted
    // even when the filter narrows the seed to zero matches, so the user
    // can always clear it — the seed pages all have child blocks, so the
    // `Stub` facet empties the list here, exercising that exact path.)
    await expect(page.getByRole('group', { name: 'Filter: Stub' })).toBeVisible()

    // Remove the chip — it disappears and the page grid comes back.
    await page.getByRole('button', { name: 'Remove filter Stub' }).click()
    await expect(page.getByRole('group', { name: 'Filter: Stub' })).toHaveCount(0)
    await expect(page.getByRole('grid')).toBeVisible()
  })

  test('does not render the filter row when the densityV1 flag is off', async ({ page }) => {
    // No flag set — boots on the legacy `listBlocks` path, which has no
    // server-side filter support and therefore no chip row.
    await waitForBoot(page)
    await openPagesView(page)
    await expect(page.getByRole('button', { name: 'Add filter' })).toHaveCount(0)
  })
})
