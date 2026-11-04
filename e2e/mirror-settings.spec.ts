import { expect, navigateToView, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * Settings › Data › Markdown mirror (#5363): choosing a folder turns the
 * mirror on and the card shows it; Turn off clears it. The mock's folder
 * dialog answers a fixed path and keeps the choice as its `app_settings` row,
 * so persistence shows by leaving Settings and coming back.
 */

// `MOCK_MIRROR_FOLDER` in src/lib/tauri-mock/handlers/system.ts.
const MOCK_FOLDER = '/home/mock/Agaric mirror'

async function openMirrorCard(page: import('@playwright/test').Page) {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'Data')
  await expect(page.getByTestId('mirror-panel-title')).toBeVisible()
}

test.describe('Settings › Data: Markdown mirror @settings @markdown', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('choosing a folder turns the mirror on, and Turn off clears it', async ({ page }) => {
    await openMirrorCard(page)
    await expect(page.getByText('Off. No folder chosen.')).toBeVisible()

    await page.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)
    await expect(page.getByText('No file has changed outside Agaric.')).toBeVisible()

    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(page.getByTestId('mirror-folder')).toHaveText(MOCK_FOLDER)

    await page.getByRole('button', { name: 'Turn off' }).click()
    await expect(page.getByText('Off. No folder chosen.')).toBeVisible()
    await expect(page.getByTestId('mirror-folder')).toHaveCount(0)

    await navigateToView(page, 'Journal')
    await openMirrorCard(page)
    await expect(page.getByText('Off. No folder chosen.')).toBeVisible()
  })
})
