/**
 * E2E — the first run names bringing notes in and pairing, and the sidebar
 * Sync button with no paired device reaches pairing in one step (#6520), on a
 * desktop and on a touch phone.
 *
 * In `e2e/` because every step is frontend: the onboarding flag lives in
 * localStorage, the Settings tab handoff in the navigation store, and the mock's
 * `list_peer_refs` starts empty on every fresh page.
 */

import { devices } from '@playwright/test'

import { expect, openMobileSidebar, test, waitForBoot } from './helpers'

const iPhone13 = devices['iPhone 13']
const phone = {
  viewport: iPhone13.viewport,
  hasTouch: iPhone13.hasTouch,
  isMobile: iPhone13.isMobile,
  deviceScaleFactor: iPhone13.deviceScaleFactor,
  userAgent: iPhone13.userAgent,
}
// A fresh vault: neither the onboarding nor the coach-mark flag the config seeds.
const firstRun = { storageState: { cookies: [], origins: [] } }

test.describe('first run on a desktop @boot @settings @sync @markdown', () => {
  test.use(firstRun)

  test('Import notes closes the welcome and shows the Data tab, whose Folder row names Logseq and Notion', async ({
    page,
  }) => {
    await waitForBoot(page)
    const welcome = page.getByRole('dialog', { name: 'Welcome to Agaric' })
    await welcome.getByRole('button', { name: 'Import notes' }).click()

    await expect(welcome).toHaveCount(0)
    const panel = page.getByTestId('settings-panel-data')
    await expect(panel).toBeVisible()
    await expect(
      panel.getByText('Folder (Logseq graph, Notion export, or any Markdown folder)'),
    ).toBeVisible()
  })

  test('Pair a device closes the welcome and shows the pairing section', async ({ page }) => {
    await waitForBoot(page)
    const welcome = page.getByRole('dialog', { name: 'Welcome to Agaric' })
    await welcome.getByRole('button', { name: 'Pair a device' }).click()

    await expect(welcome).toHaveCount(0)
    await expect(
      page.getByTestId('settings-panel-sync').getByRole('button', { name: 'Pair new device' }),
    ).toBeVisible()
  })
})

test.describe('first run on a phone @boot @mobile @sync', () => {
  test.use({ ...phone, ...firstRun })

  test('the welcome leads with pairing with a computer and names no key', async ({ page }) => {
    await waitForBoot(page)
    const welcome = page.getByRole('dialog', { name: 'Welcome to Agaric' })
    await expect(welcome.getByRole('button').first()).toHaveAccessibleName(
      'Pair with your computer',
    )
    await expect(welcome).not.toContainText('Press')

    await welcome.getByRole('button', { name: 'Pair with your computer' }).click()

    await expect(welcome).toHaveCount(0)
    await expect(
      page.getByTestId('settings-panel-sync').getByRole('button', { name: 'Pair new device' }),
    ).toBeVisible()
  })
})

test.describe('no devices paired on a phone @sync @mobile', () => {
  test.use(phone)

  test('Pair a device closes the drawer and opens the pairing sheet', async ({ page }) => {
    await waitForBoot(page)
    const drawer = await openMobileSidebar(page)
    await drawer.getByRole('button', { name: 'Sync', exact: true }).click()

    // On a phone the confirmation is a bottom sheet, not an alert dialog.
    const noPeers = page.getByRole('dialog', { name: 'No devices paired' })
    await expect(noPeers).toBeVisible()
    await noPeers.getByRole('button', { name: 'Pair a device' }).click()

    const pairing = page.getByRole('dialog', { name: 'Pair device' })
    await expect(pairing.getByText(/alpha/i)).toBeVisible()
    await expect(page.locator('[data-sidebar="sidebar"]')).not.toBeInViewport()
  })
})
