/**
 * E2E — Settings navigation and the quick-capture button on a phone (#5344, #7040).
 *
 * A phone opens Settings on the list of its sections and drills into one, with
 * Back to the list in the view header; a section asked for (stored or linked)
 * opens straight away. The quick-capture button stays off Settings, whose
 * right-aligned switches it would cover; elsewhere the scroll viewport keeps
 * bottom padding for it, except on Graph, whose canvas fills the viewport.
 */

import { devices, type Page } from '@playwright/test'

import {
  expect,
  navigateMobile,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

const iPhone13 = devices['iPhone 13']

// Per-context fields only: `defaultBrowserType` would force a new worker.
const phone = {
  hasTouch: iPhone13.hasTouch,
  isMobile: iPhone13.isMobile,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}

const sectionList = (page: Page) => page.getByRole('navigation', { name: 'Settings' })
const backToSections = (page: Page) =>
  page.getByRole('button', { name: 'Back to all settings', exact: true })

test.describe('Settings on a phone @mobile @settings', () => {
  test.use({ ...phone, viewport: { width: 412, height: 915 } })

  test('opens on its sections; one drills in, and Back returns to the list', async ({ page }) => {
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')

    const list = sectionList(page)
    await expect(list.getByRole('button', { name: 'General', exact: true })).toBeVisible()
    await expect(list.getByRole('button', { name: 'Sync & devices', exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: 'Settings', exact: true })).toHaveCount(0)
    await expect(page.getByTestId(/^settings-panel-/)).toHaveCount(0)

    await list.getByRole('button', { name: 'Editor', exact: true }).click()
    await expect(page.getByTestId('settings-panel-editor')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Editor', level: 2 })).toBeVisible()
    await expect(sectionList(page)).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Settings', exact: true })).toHaveCount(0)

    await backToSections(page).click()
    await expect(
      sectionList(page).getByRole('button', { name: 'Editor', exact: true }),
    ).toBeVisible()
    await expect(page.getByTestId('settings-panel-editor')).toHaveCount(0)
  })

  test('a stored section opens straight away, with Back to the list', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('agaric-settings-active-tab', 'sync'))
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')

    await expect(page.getByTestId('settings-panel-sync')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Pair new device' })).toBeInViewport({
      ratio: 1,
    })
    await backToSections(page).click()
    await expect(sectionList(page).getByRole('button', { name: 'Sync & devices' })).toBeVisible()
  })

  test('every section row is a 44px touch target', async ({ page }) => {
    // A phone with no hardware keyboard, like an Android WebView: no Keyboard row (#7040).
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, 'keyboard')
    })
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')

    const rows = sectionList(page).getByRole('button')
    await expect(rows).toHaveCount(11)
    for (const row of await rows.all()) {
      expect((await row.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
    }
  })

  test('no Editor control sits under the quick-capture button at rest', async ({ page }) => {
    await waitForBoot(page)
    const fab = page.getByTestId('quick-capture-fab')
    await expect(fab).toBeVisible()
    await navigateMobile(page, 'Settings')
    await openSettingsTab(page, 'Editor')
    const panel = page.getByTestId('settings-panel-editor')
    await expect(panel.getByRole('switch').first()).toBeVisible()

    // Every phone height: the button floats over whichever row the screen's foot reaches.
    for (const height of [664, 700, 740, 780, 820, 844, 880, 915]) {
      await page.setViewportSize({ width: 412, height })
      const fabBox = (await fab.isVisible()) ? await fab.boundingBox() : null
      if (fabBox === null) continue
      for (const control of await panel.locator('button, [role="switch"], input').all()) {
        const box = await control.boundingBox()
        if (box === null) continue
        const overlaps =
          box.x < fabBox.x + fabBox.width &&
          fabBox.x < box.x + box.width &&
          box.y < fabBox.y + fabBox.height &&
          fabBox.y < box.y + box.height
        expect(
          overlaps,
          `at ${height}px ${await control.getAttribute('id')} is under the FAB`,
        ).toBe(false)
      }
    }
  })
})

test.describe('Graph on a phone @mobile @settings', () => {
  test.use({ ...phone, viewport: iPhone13.viewport })

  test('the canvas still runs under the quick-capture button', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Graph')
    const graph = page.getByTestId('graph-view')
    await expect(graph).toBeVisible()

    const canvas = await graph.boundingBox()
    const fab = await page.getByTestId('quick-capture-fab').boundingBox()
    if (canvas === null || fab === null) throw new Error('the graph or the FAB has no box')
    expect(
      canvas.y + canvas.height,
      `the graph ends at ${canvas.y + canvas.height}px, the FAB at ${fab.y + fab.height}px`,
    ).toBeGreaterThanOrEqual(fab.y + fab.height)
  })
})

test.describe('Settings on a touch tablet @mobile @settings', () => {
  test.use({ hasTouch: true, viewport: { width: 820, height: 1180 } })

  test('the rail tabs are 44px touch targets', async ({ page }) => {
    await waitForBoot(page)
    await navigateToView(page, 'Settings')
    const tab = page.getByRole('tab', { name: 'General', exact: true })
    await expect(tab).toBeVisible()
    expect((await tab.boundingBox())?.height).toBeGreaterThanOrEqual(44)
  })
})

test('Settings at a desktop width shows the tab rail, not the phone section list @mobile @settings', async ({
  page,
}) => {
  await waitForBoot(page)
  await navigateToView(page, 'Settings')

  await expect(page.getByRole('tablist', { name: 'Settings' })).toBeVisible()
  await expect(page.getByTestId('settings-panel-general')).toBeVisible()
  await expect(sectionList(page)).toHaveCount(0)
  await expect(backToSections(page)).toHaveCount(0)
})

/**
 * #7040 — a phone shows no keyboard-only UI until a hardware keyboard shows
 * itself with a key press: no Keyboard tab in Settings, no "Press ? for help"
 * under Search. The emulated phone runs on desktop Chromium, whose Keyboard Map
 * API reports the host's keyboard; a real phone's browser has no such API, so
 * it is taken away here.
 */
test.describe('Keyboard-only UI on a phone with no keyboard (#7040) @mobile @settings @search', () => {
  test.use({
    viewport: { width: 412, height: 915 },
    ...phone,
  })

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      Reflect.deleteProperty(Navigator.prototype, 'keyboard')
    })
    await waitForBoot(page)
  })

  test('Settings offers no Keyboard section until a hardware key is pressed', async ({ page }) => {
    await navigateMobile(page, 'Settings')
    const list = sectionList(page)
    await expect(list.getByRole('button', { name: 'Editor', exact: true })).toBeVisible()
    await expect(list.getByRole('button', { name: 'Keyboard', exact: true })).toHaveCount(0)

    // A Bluetooth keyboard: its first key brings the section back.
    await page.keyboard.press('Escape')
    await expect(list.getByRole('button', { name: 'Keyboard', exact: true })).toBeVisible()
  })

  test('Search names its filter syntax with no key to press', async ({ page }) => {
    await navigateMobile(page, 'Search')
    const hint = page.locator('#search-filter-hint')
    await expect(hint).toHaveText('Filter with tag:#name or path:Journal/*, or use Add filter.')
  })
})
