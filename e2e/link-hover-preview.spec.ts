import type { Page } from '@playwright/test'

import {
  expect,
  navigateToView,
  openPage,
  openSettingsTab,
  seedSearchBlocks,
  test,
  waitForBoot,
} from './helpers'

/**
 * Hover preview of an external link (`LinkPreviewTooltip`) and the Settings ›
 * Editor "Fetch link previews on hover" toggle (#5733). The mock's
 * `fetch_link_metadata` answers the title "Mock Title" and caches the row, so
 * the tooltip shows what the fetch returned. The toggle gates only a cache
 * miss: a preview already cached still shows with it off, so the off case uses
 * a link never hovered before, and its positive control (same link, toggle on)
 * runs after it.
 */

const PAGE = 'Getting Started'
// SEED_IDS.PAGE_GETTING_STARTED in src/lib/tauri-mock/seed.ts
const PAGE_ID = '00000000000000000000PAGE01'
const LINK_URL = 'https://docs.example.test/guide'

async function flipPreviewFetch(page: Page, on: boolean): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Editor')
  const toggle = page.getByRole('switch', { name: 'Fetch link previews on hover' })
  await toggle.click()
  await expect(toggle).toBeChecked({ checked: on })
}

const chip = (page: Page) => page.locator(`[data-testid="external-link"][data-href="${LINK_URL}"]`)
const tooltip = (page: Page) => page.getByTestId('link-preview-tooltip')

test.describe('External link hover preview', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install()
    await waitForBoot(page)
    await seedSearchBlocks(page, [
      { content: `Read [the guide](${LINK_URL}) first`, parentId: PAGE_ID },
    ])
  })

  test('hovering a link chip shows the fetched title', async ({ page }) => {
    await openPage(page, PAGE)
    await chip(page).hover()
    await expect(tooltip(page)).toHaveText('Mock Title')
  })

  test('with the toggle off, hovering an uncached link closes the preview without a title', async ({
    page,
  }) => {
    await flipPreviewFetch(page, false)
    await openPage(page, PAGE)

    // Paused, the fetch debounce (`DEBOUNCE_MS` in `useLinkPreview.ts`) cannot
    // fire, so the loading shell stays up: proof the hover reached the chip
    // before the negative below.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000)
    await chip(page).hover()
    await expect(tooltip(page)).toContainText(LINK_URL)
    await page.clock.resume()
    await expect(tooltip(page)).toHaveCount(0)

    await flipPreviewFetch(page, true)
    await openPage(page, PAGE)
    await chip(page).hover()
    await expect(tooltip(page)).toHaveText('Mock Title')
  })
})
