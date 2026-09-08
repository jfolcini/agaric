import type { Locator, Page } from '@playwright/test'

import { expect, navigateToView, test, waitForBoot } from './helpers'

/**
 * Geometry guard for the `Pages` list's two row shapes.
 *
 * The list interleaves flat top-level page rows (`DensityRow`) with
 * namespace subtrees (`PageTreeItem`). Only the flat row reserves width
 * for a multi-select checkbox and a star toggle, and both keep that
 * width while invisible. A subtree that does not reserve the same run
 * therefore starts LEFT of the flat rows around it, which inverts the
 * hierarchy on screen: every flat page listed after a namespace root
 * looks like a child of that root. Reported against 0.10.0 on a vault
 * where a top-level `Nico` page read as `workstations/management/Nico`.
 *
 * `page-tree-gutter` (`src/index.css`) is the fix. These assertions are
 * the pin on both sides of the mirror — they redden if the utility goes
 * away, and equally if `DensityRow`'s leading affordances change size.
 *
 * jsdom has no layout engine, so this cannot live in a vitest file.
 */

const NAMESPACED_PAGE = 'work/project-a'

/** A seeded top-level page with no `/`, so it renders as a flat row. */
const FLAT_PAGE = 'Quick Notes'

async function openPagesView(page: Page): Promise<void> {
  await navigateToView(page, 'Pages')
  await expect(page.getByRole('grid')).toBeVisible()
}

/** Left edge of an element's border box, in viewport pixels. */
async function leftEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox()
  if (box === null) throw new Error('element is not laid out')
  return box.x
}

test.describe('Pages view — namespace indentation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a namespace root aligns with top-level pages and its children sit deeper', async ({
    page,
  }) => {
    await openPagesView(page)

    // Seed a namespace. The mock's seed pages are all flat, so without
    // this the tree half of the list never renders.
    await page.getByPlaceholder('New page name...').fill(NAMESPACED_PAGE)
    // Scoped to the header outlet: a bare name match also hits the
    // sidebar's own "New Page" entry.
    await page
      .getByTestId('view-header-outlet')
      .getByRole('button', { name: /New Page/i })
      .click()
    // Creating a page navigates to its editor.
    await openPagesView(page)

    const flatRow = page.locator(`[data-page-item]:has-text("${FLAT_PAGE}")`)
    // The title button — the first thing after the row's checkbox and
    // star, i.e. where a flat row's content actually begins.
    const flatContent = flatRow.locator('.page-browser-item')
    const flatTitle = flatRow.locator('.page-browser-item-title')
    const namespaceRoot = page.getByRole('button', { name: 'Toggle work namespace' })
    const nestedTitle = page.locator(`[data-page-tree-row] span[title="${NAMESPACED_PAGE}"]`)

    await expect(flatContent).toBeVisible()
    await expect(namespaceRoot).toBeVisible()
    await expect(nestedTitle).toBeVisible()

    // A namespace root and a flat page are siblings at the top level, so
    // their content starts at the same x. Both sit at the gutter; the
    // tolerance is for subpixel layout only.
    const rootLeft = await leftEdge(namespaceRoot)
    const flatContentLeft = await leftEdge(flatContent)
    expect(Math.abs(rootLeft - flatContentLeft)).toBeLessThanOrEqual(1)

    // A page INSIDE the namespace is one level deeper than a top-level
    // page, and must read that way. This is the assertion the bug broke:
    // the nested title used to sit ~48px LEFT of the flat one.
    expect(await leftEdge(nestedTitle)).toBeGreaterThan(await leftEdge(flatTitle))
  })
})
