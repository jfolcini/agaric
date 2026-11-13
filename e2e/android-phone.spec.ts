import { devices, type Page } from '@playwright/test'

import { expect, navigateMobile, openSettingsTab, test, waitForBoot } from './helpers'

/**
 * E2E — what the app does only on an Android phone, on the mock: the frontend
 * half of each flow. The Kotlin half (MediaStore, the share intent) has no
 * harness here and is checked on a device (#6513).
 *
 * The mock stands in for the Android backend: `save_file_to_downloads` records
 * each file in `__mockSavedFiles` and answers with its name.
 */

const pixel = devices['Pixel 7']

test.use({
  viewport: pixel.viewport,
  hasTouch: pixel.hasTouch,
  isMobile: pixel.isMobile,
  deviceScaleFactor: pixel.deviceScaleFactor,
  userAgent: pixel.userAgent,
})

interface SavedFile {
  fileName: string
  mimeType: string
  bytes: string
}

/** The files the mock's `save_file_to_downloads` was handed. */
function savedFiles(page: Page): Promise<SavedFile[]> {
  return page.evaluate(
    () => (globalThis as { __mockSavedFiles?: SavedFile[] }).__mockSavedFiles ?? [],
  )
}

test.describe('Android phone @mobile @settings @markdown', () => {
  test('Export this space saves the ZIP to Downloads and says so (#6546)', async ({ page }) => {
    await waitForBoot(page)
    await navigateMobile(page, 'Settings')
    await openSettingsTab(page, 'Data')

    await page.getByRole('button', { name: 'Export this space', exact: true }).click()

    await expect.poll(() => savedFiles(page)).toHaveLength(1)
    const [file] = await savedFiles(page)
    expect(file?.fileName).toMatch(/^agaric-export-.*\d{4}-\d{2}-\d{2}\.zip$/)
    expect(file?.mimeType).toBe('application/zip')
    // A ZIP's local file header, base64-encoded: the bytes are the archive.
    expect(file?.bytes.startsWith('UEsDB')).toBe(true)
    await expect(page.getByText(`Saved ${file?.fileName} to Downloads`)).toBeVisible()
    await expect(page.getByText('Export complete')).toBeVisible()
  })
})
