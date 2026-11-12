/**
 * #6544 — the Pages header's view buttons name their destination in visible
 * text at desktop widths, so Graph, Advanced Query, Templates and Trash are
 * reachable without decoding an icon.
 */

import { expect, expectViewLoaded, navigateToView, test, waitForBoot } from './helpers'

const DESTINATIONS = ['Tags', 'Graph', 'Advanced Query', 'Templates', 'Trash'] as const

test.use({ viewport: { width: 1280, height: 800 } })

for (const view of DESTINATIONS) {
  test(`the ${view} button in the Pages header shows its name and opens the view @pages @graph @search`, async ({
    page,
  }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Pages')
    const label = page
      .locator('.page-browser-header')
      .getByRole('button')
      .getByText(view, { exact: true })
    // A visually hidden label is a 1 px box; a shown one is as wide as its word.
    await expect
      .poll(() => label.evaluate((el) => el.getBoundingClientRect().width))
      .toBeGreaterThan(20)
    await label.click()
    await expectViewLoaded(page, view)
  })
}
