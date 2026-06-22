/**
 * E2E — mobile horizontal-overflow sweep (#1966).
 *
 * Opens every reachable top-level view (and a couple of key dialogs) at phone
 * widths and asserts NOTHING overflows the viewport horizontally — the failure
 * mode behind the pairing-dialog report (buttons bleeding off a narrow screen)
 * and the class of bug the user asked to sweep for across the whole UI.
 *
 * NOT run in CI: this is a broad, lower-signal visual guard that is most useful
 * locally while iterating on responsive layout, and it would add wall-clock to
 * the sharded CI run for little marginal protection. Gated with
 * `test.skip(!!process.env.CI, …)` per spec, mirroring the existing
 * `process.env['CI']` convention in `playwright.config.ts`.
 *
 * Run locally:
 *   npx playwright test e2e/mobile-overflow.spec.ts --workers=1
 */

import { devices } from '@playwright/test'

import {
  activeDialog,
  activeRoleDialog,
  activeSheet,
  expect,
  expectNoHorizontalOverflow,
  test,
  waitForBoot,
} from './helpers'

// `process` is provided by the Playwright (node) runtime; e2e files are not in
// any tsconfig `include`, so declare the minimal surface we use to keep the
// editor/LSP happy without pulling in @types/node.
declare const process: { env: Record<string, string | undefined> }

// Two narrow profiles: the existing iPhone-13 baseline (390px) and a narrower
// 360px Android width (small Pixel / Galaxy) that exposes overflow the 390px
// case misses. Both are below the 768px `useIsMobile` breakpoint, so the app
// renders its mobile chrome (icon rail + sheets).
const iPhone13 = devices['iPhone 13']
const PROFILES = [
  { name: 'iPhone 13 · 390px', use: { ...pick(iPhone13), viewport: { width: 390, height: 844 } } },
  {
    name: 'narrow Android · 360px',
    use: { ...pick(iPhone13), viewport: { width: 360, height: 800 } },
  },
] as const

// Spread only the per-context fields. Including `defaultBrowserType` would force
// a new worker and Playwright rejects it inside a describe (see
// search-view-mobile.spec.ts).
function pick(device: (typeof devices)[string]) {
  return {
    hasTouch: device.hasTouch,
    isMobile: device.isMobile,
    deviceScaleFactor: device.deviceScaleFactor,
    userAgent: device.userAgent,
  }
}

// Top-level views, keyed by the accessible name of their rail nav button
// (the i18n `sidebar.*` label). `query`'s label is "Advanced Query".
const VIEWS = [
  'Journal',
  'Pages',
  'Search',
  'Tags',
  'Graph',
  'Templates',
  'Advanced Query',
  'Status',
  'History',
  'Trash',
  'Settings',
] as const

for (const profile of PROFILES) {
  test.describe(`mobile overflow sweep — ${profile.name}`, () => {
    test.skip(!!process.env['CI'], 'mobile layout sweep runs locally only')
    test.use(profile.use)

    for (const view of VIEWS) {
      test(`${view} view has no horizontal overflow`, async ({ page }) => {
        await waitForBoot(page)

        // Navigate via the persistent mobile icon rail (the desktop sidebar is
        // not rendered below `md`). Scope to the rail so the name is unambiguous.
        const rail = page.locator('[data-mobile-rail="true"]')
        const navButton = rail.getByRole('button', { name: view, exact: true })
        await navButton.click()
        // The active nav item flips `aria-current="page"` synchronously; wait
        // for it so we measure the new view, not the previous one.
        await expect(navButton).toHaveAttribute('aria-current', 'page')
        // Let the lazy view chunk resolve and layout settle before measuring.
        await page.waitForLoadState('networkidle')
        await page.waitForTimeout(250)

        await expectNoHorizontalOverflow(page, undefined, `${view} view @ ${profile.name}`)
      })
    }

    test('collapsed sidebar rail clips its content (no text bleed)', async ({ page }) => {
      await waitForBoot(page)
      const container = page.locator('[data-mobile-rail="true"] [data-slot="sidebar-container"]')
      await expect(container).toBeVisible()

      // The rail is a fixed 48px column; its content must be hard-clipped so a
      // menu label can never bleed past the edge (#1967). Assert the clip is in
      // place AND the rail itself does not scroll horizontally.
      const overflowX = await container.evaluate((el) => getComputedStyle(el).overflowX)
      expect(overflowX, 'rail container must clip horizontally').toBe('hidden')

      const railWidth = await container.evaluate((el) =>
        Math.round(el.getBoundingClientRect().width),
      )
      expect(railWidth, 'icon rail should be the 48px icon width').toBeLessThanOrEqual(56)
    })

    test('Keyboard Shortcuts dialog has no horizontal overflow', async ({ page }) => {
      await waitForBoot(page)
      const rail = page.locator('[data-mobile-rail="true"]')
      const shortcutsBtn = rail.getByRole('button', { name: 'Shortcuts', exact: true })
      // Best-effort: if the trigger isn't reachable in this build, skip cleanly
      // rather than fail the sweep on an unrelated gap.
      if ((await shortcutsBtn.count()) === 0) {
        test.skip(true, 'Shortcuts trigger not present')
      }
      await shortcutsBtn.click()

      // useDialogOrSheet renders a Sheet on mobile; fall back to a role=dialog
      // if a plain dialog is used instead.
      const sheet = activeSheet(page)
      const surface = (await sheet.count()) > 0 ? sheet : activeRoleDialog(page)
      await expect(surface).toBeVisible()
      await page.waitForTimeout(150)
      await expectNoHorizontalOverflow(page, surface, `Shortcuts dialog @ ${profile.name}`)
    })

    test('Pairing dialog (Settings → Sync) has no horizontal overflow', async ({ page }) => {
      await waitForBoot(page)
      const rail = page.locator('[data-mobile-rail="true"]')
      await rail.getByRole('button', { name: 'Settings', exact: true }).click()

      // Open the "Sync & Devices" settings tab, which hosts DeviceManagement
      // (mono device-id row, peers list, "Pair New Device").
      const syncTab = page.getByRole('tab', { name: 'Sync & Devices', exact: true })
      await expect(syncTab).toBeVisible()
      await syncTab.click()
      await expect(page.getByTestId('settings-panel-sync')).toBeVisible()
      // The device id loads async; the pair button is gated on it.
      const pairBtn = page.locator('.device-pair-btn')
      await expect(pairBtn).toBeVisible()
      // The device-management panel itself must not overflow (long mono ids).
      await expectNoHorizontalOverflow(page, undefined, `Settings · Sync panel @ ${profile.name}`)

      // Open the pairing dialog and assert the entry-mode toggle (the row that
      // overflowed before #1966) stays within the dialog at this width.
      await pairBtn.click()
      const dialog = activeDialog(page)
      await expect(dialog).toBeVisible()
      // Wait for the entry-mode toggle to render (pairing init + lazy bits).
      await expect(
        dialog.getByRole('button', { name: 'Type Passphrase', exact: true }),
      ).toBeVisible()
      await page.waitForTimeout(150)
      await expectNoHorizontalOverflow(page, dialog, `Pairing dialog @ ${profile.name}`)
    })
  })
}
