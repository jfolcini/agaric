import { expect, test } from '@playwright/test'

interface MockErrorWindow extends Window {
  __injectMockError?: (command: string, message: string) => void
  __clearMockErrors?: () => void
}

/**
 * E2E error scenario tests for the Agaric app.
 *
 * These tests inject errors via the mock layer's __injectMockError window
 * global and verify the app handles failures gracefully (e.g. error toasts,
 * no crashes). The mock layer (tauri-mock.ts) auto-activates in the browser.
 */
test.describe('Error scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for BootGate to resolve and Journal view to load
    await expect(page.locator('header').getByText('Journal')).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    // Always clean up injected errors
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__clearMockErrors?.()
    })
  })

  test('shows error toast when block creation fails', async ({ page }) => {
    // Inject an error for the create_block command
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'create_block',
        'Validation failed',
      )
    })

    // Try to create a block via the input form
    const input = page.getByPlaceholder('Write something...')
    await input.fill('This should fail')
    await input.press('Enter')

    // Verify error feedback appears (toast or error message)
    await expect(page.getByText(/failed|error/i)).toBeVisible({ timeout: 3000 })
  })

  test('shows error toast when edit fails', async ({ page }) => {
    // First, create a block successfully
    const input = page.getByPlaceholder('Write something...')
    await input.fill('Editable block')
    await input.press('Enter')
    await expect(page.getByText('Editable block')).toBeVisible()

    // Now inject an error for future edit_block calls
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.('edit_block', 'Content too large')
    })

    // Click the block to focus/edit it, type something, then blur to trigger edit
    const blockText = page.getByText('Editable block')
    await blockText.click()

    // Type additional content to trigger an edit on blur
    await page.keyboard.type(' modified')
    // Click elsewhere to blur and trigger the save
    await page.locator('header').click()

    // Verify error feedback appears
    await expect(page.getByText(/failed|error/i)).toBeVisible({ timeout: 3000 })
  })

  test('app does not crash when delete fails', async ({ page }) => {
    // Create a block first
    const input = page.getByPlaceholder('Write something...')
    await input.fill('Block to fail-delete')
    await input.press('Enter')
    await expect(page.getByText('Block to fail-delete')).toBeVisible()

    // Inject an error for delete_block
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'delete_block',
        'Permission denied',
      )
    })

    // Try to delete the block
    const blockText = page.getByText('Block to fail-delete')
    await blockText.hover()
    const deleteBtn = blockText.locator('..').getByRole('button', { name: 'Delete block' })
    await deleteBtn.click()

    // The block should still be visible (delete failed) and the app should not crash
    // Check app is still functional by verifying header is still visible
    await expect(page.locator('header').getByText('Journal')).toBeVisible()
  })

  test('recovers after clearing injected errors', async ({ page }) => {
    // Inject an error
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'create_block',
        'Temporary failure',
      )
    })

    // Try to create a block — should fail
    const input = page.getByPlaceholder('Write something...')
    await input.fill('Should fail')
    await input.press('Enter')

    // Clear the errors
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__clearMockErrors?.()
    })

    // Now creation should succeed
    await input.fill('Should succeed')
    await input.press('Enter')
    await expect(page.getByText('Should succeed')).toBeVisible()
  })
})
