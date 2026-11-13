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

test.describe('Android phone @mobile @settings @markdown @journal', () => {
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

  // The app as Android shows it: `MainActivity` binds `AgaricShareBridge` to the
  // webview, and taking the pending text clears it.
  test('text shared from another app opens Quick Capture; only Capture saves it (#6555)', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const scope = window as unknown as {
        __sharedText: string | null
        AgaricShareBridge: { takePendingText: () => string | null }
      }
      scope.__sharedText = 'Shared on launch'
      scope.AgaricShareBridge = {
        takePendingText: () => {
          const text = scope.__sharedText
          scope.__sharedText = null
          return text
        },
      }
    })
    const field = page.getByRole('textbox', { name: 'Quick capture content' })
    const dialog = page.getByTestId('quick-capture-dialog')
    const reopenJournal = async (): Promise<void> => {
      await navigateMobile(page, 'Pages')
      await navigateMobile(page, 'Journal')
    }

    // A share that started the app.
    await waitForBoot(page)
    await expect(field).toHaveValue('Shared on launch')
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await reopenJournal()
    await expect(page.getByText('Shared on launch', { exact: true })).toHaveCount(0)

    // A share into the running app: Android resumes the activity after the intent.
    await page.evaluate(() => {
      ;(window as unknown as { __sharedText: string | null }).__sharedText = 'Shared while open'
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(field).toHaveValue('Shared while open')
    await dialog.getByRole('button', { name: 'Capture', exact: true }).click()
    await expect(page.getByText("Captured to today's journal")).toBeVisible()
    await reopenJournal()
    await expect(page.getByText('Shared while open', { exact: true })).toBeVisible()
  })

  test('a newer release is announced at launch and named in Settings › About (#6546)', async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem('__mockNewerRelease', '99.0.0'))
    await waitForBoot(page)

    const toast = page.locator('[data-sonner-toast]', { hasText: 'Agaric 99.0.0 is available' })
    await expect(toast).toBeVisible()
    await expect(toast.getByRole('button', { name: 'Open releases page' })).toBeVisible()

    await navigateMobile(page, 'Settings')
    await openSettingsTab(page, 'About')
    await expect(page.getByText('Update available: v99.0.0')).toBeVisible()
  })
})
