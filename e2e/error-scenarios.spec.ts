import { expect, test } from './helpers'

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
 *
 * Block operations use the "Getting Started" seed page (TipTap roving editor).
 */

async function openGettingStarted(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Pages', exact: true }).click()
  await page.getByText('Getting Started').click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible({ timeout: 5000 })
}

/** Click "Add block", wait for editor, type text, press Enter to save. */
async function addBlock(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('button', { name: /add block/i }).click()
  const editor = page.getByRole('textbox', { name: 'Block editor' })
  await expect(editor).toBeVisible({ timeout: 5000 })
  await editor.pressSequentially(text, { delay: 30 })
  await editor.press('Enter')
  await expect(page.getByText(text)).toBeVisible()
}

test.describe('Error scenarios', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for BootGate to resolve and Journal view to load
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    // Always clean up injected errors
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__clearMockErrors?.()
    })
  })

  test('shows error toast when block creation fails', async ({ page }) => {
    await openGettingStarted(page)

    // Inject an error for the create_block command
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'create_block',
        'Validation failed',
      )
    })

    // Try to create a block via the Add block button
    await page.getByRole('button', { name: /add block/i }).click()

    // Verify error feedback appears (toast or error message)
    await expect(page.getByText(/failed|error/i)).toBeVisible()
  })

  test('shows error toast when edit fails', async ({ page }) => {
    await openGettingStarted(page)

    // Click the first seed block to open the editor
    const firstBlock = page.getByRole('button', { name: 'Edit block' }).first()
    await firstBlock.click()

    // Now inject an error for future edit_block calls
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.('edit_block', 'Content too large')
    })

    // Type additional content to trigger an edit on blur
    const editor = page.getByRole('textbox', { name: 'Block editor' })
    await expect(editor).toBeVisible()
    await editor.pressSequentially(' modified', { delay: 30 })

    // Press Enter to save (triggers edit_block which will fail)
    await editor.press('Enter')

    // Verify error feedback appears
    await expect(page.getByText(/failed|error/i)).toBeVisible()
  })

  test('app does not crash when delete fails', async ({ page }) => {
    await openGettingStarted(page)

    // Create a block first
    await addBlock(page, 'Block to fail-delete')

    // Inject an error for delete_block
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'delete_block',
        'Permission denied',
      )
    })

    // Try to delete the block
    const block = page
      .locator('[data-testid="sortable-block"]')
      .filter({ hasText: 'Block to fail-delete' })
    await block.hover()
    const deleteBtn = block.getByRole('button', { name: /delete block/i })
    await deleteBtn.click()

    // The block should still be visible (delete failed) and the app should not crash
    // Check app is still functional by verifying header is still visible
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('recovers after clearing injected errors', async ({ page }) => {
    await openGettingStarted(page)

    // Inject an error
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__injectMockError?.(
        'create_block',
        'Temporary failure',
      )
    })

    // Try to create a block — should fail
    await page.getByRole('button', { name: /add block/i }).click()

    // Clear the errors
    await page.evaluate(() => {
      ;(window as unknown as MockErrorWindow).__clearMockErrors?.()
    })

    // Now creation should succeed
    await addBlock(page, 'Should succeed')
    await expect(page.getByText('Should succeed')).toBeVisible()
  })
})
