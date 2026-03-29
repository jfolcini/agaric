import { expect, test } from '@playwright/test'

/**
 * E2E editor lifecycle tests for the Agaric app.
 *
 * The default view is JournalPage which manages blocks via an input form.
 * The mock layer (tauri-mock.ts) auto-activates in the browser and provides
 * an in-memory store — each page load resets state.
 */
test.describe('Editor lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for BootGate to resolve and Journal view to load
    // Use the header text which is unique (sidebar button also says "Journal")
    await expect(page.locator('header').getByText('Journal')).toBeVisible()
  })

  test('shows empty state when no blocks exist', async ({ page }) => {
    // The JournalPage shows an empty state message for the current date
    await expect(page.getByText('Add one below')).toBeVisible()
  })

  test('creates a block via the input form', async ({ page }) => {
    // Type in the input field and submit
    const input = page.getByPlaceholder('Write something...')
    await expect(input).toBeVisible()

    await input.fill('Hello, world!')
    await input.press('Enter')

    // Verify the block appears in the list
    await expect(page.getByText('Hello, world!')).toBeVisible()

    // Empty state should be gone
    await expect(page.getByText('Add one below')).not.toBeVisible()
  })

  test('creates a block via the Add button', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')
    await input.fill('Test block')

    const addButton = page.getByRole('button', { name: 'Add' })
    await addButton.click()

    await expect(page.getByText('Test block')).toBeVisible()
  })

  test('clears input after block creation', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')
    await input.fill('Block content')
    await input.press('Enter')

    // Input should be cleared after submission
    await expect(input).toHaveValue('')
  })

  test('creates multiple blocks', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')

    await input.fill('First block')
    await input.press('Enter')

    await input.fill('Second block')
    await input.press('Enter')

    await input.fill('Third block')
    await input.press('Enter')

    // All three blocks should be visible
    await expect(page.getByText('First block')).toBeVisible()
    await expect(page.getByText('Second block')).toBeVisible()
    await expect(page.getByText('Third block')).toBeVisible()
  })

  test('deletes a block via the delete button', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')

    // Create a block
    await input.fill('Block to delete')
    await input.press('Enter')
    await expect(page.getByText('Block to delete')).toBeVisible()

    // The delete button is inside the block's row, visible on hover.
    // Hover over the block text to reveal the delete button.
    const blockText = page.getByText('Block to delete')
    await blockText.hover()

    // Click the delete button (accessible via aria-label)
    const deleteBtn = blockText.locator('..').getByRole('button', { name: 'Delete block' })
    await deleteBtn.click()

    // Block should be removed
    await expect(page.getByText('Block to delete')).not.toBeVisible()

    // Empty state should return
    await expect(page.getByText('Add one below')).toBeVisible()
  })

  test('Add button is disabled when input is empty', async ({ page }) => {
    const addButton = page.getByRole('button', { name: 'Add' })
    await expect(addButton).toBeDisabled()
  })

  test('does not create a block with empty/whitespace input', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')
    await input.fill('   ')
    await input.press('Enter')

    // Empty state should still show (whitespace-only should not create a block)
    await expect(page.getByText('Add one below')).toBeVisible()
  })

  test('navigates between sidebar views', async ({ page }) => {
    // Default view is Journal
    await expect(page.getByText('Add one below')).toBeVisible()

    // Navigate to Pages
    await page.getByRole('button', { name: 'Pages' }).click()
    await expect(page.getByText('No pages yet')).toBeVisible()

    // Navigate to Tags
    await page.getByRole('button', { name: 'Tags' }).click()
    // Tags view should load (check for the Tags heading in the header)
    await expect(page.locator('header').getByText('Tags')).toBeVisible()

    // Navigate to Trash
    await page.getByRole('button', { name: 'Trash' }).click()
    await expect(page.locator('header').getByText('Trash')).toBeVisible()

    // Navigate to Status
    await page.getByRole('button', { name: 'Status' }).click()
    await expect(page.locator('header').getByText('Status')).toBeVisible()

    // Navigate to Conflicts
    await page.getByRole('button', { name: 'Conflicts' }).click()
    await expect(page.locator('header').getByText('Conflicts')).toBeVisible()

    // Navigate back to Journal
    await page.getByRole('button', { name: 'Journal' }).click()
    await expect(page.locator('header').getByText('Journal')).toBeVisible()
  })

  test('journal date navigation works', async ({ page }) => {
    // The header shows the current date
    const today = new Date()
    const dateStr = today.toLocaleDateString('en-US', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    await expect(page.getByText(dateStr, { exact: true })).toBeVisible()

    // Navigate to previous day
    await page.getByRole('button', { name: 'Prev' }).click()

    // The "Today" button should appear (since we're no longer on today)
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible()

    // Click "Today" to return
    await page.getByRole('button', { name: 'Today' }).click()
    await expect(page.getByText(dateStr, { exact: true })).toBeVisible()
  })

  test('blocks persist within the same page session', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')

    // Create blocks
    await input.fill('Persistent block A')
    await input.press('Enter')
    await input.fill('Persistent block B')
    await input.press('Enter')

    // Navigate away to Status (which has no interaction with blocks mock)
    await page.getByRole('button', { name: 'Status' }).click()
    await expect(page.locator('header').getByText('Status')).toBeVisible()

    // Navigate back to Journal
    await page.getByRole('button', { name: 'Journal' }).click()

    // Blocks should still be there (mock is in-memory, persists during session)
    await expect(page.getByText('Persistent block A')).toBeVisible()
    await expect(page.getByText('Persistent block B')).toBeVisible()
  })

  test('pages view allows creating a new page', async ({ page }) => {
    // Navigate to Pages
    await page.getByRole('button', { name: 'Pages' }).click()
    await expect(page.getByText('No pages yet')).toBeVisible()

    // Create a new page
    await page.getByRole('button', { name: 'New Page' }).click()

    // A page titled "Untitled" should appear
    await expect(page.getByText('Untitled')).toBeVisible()

    // Empty state should be gone
    await expect(page.getByText('No pages yet')).not.toBeVisible()
  })

  test('deletes one block while others remain', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')

    // Create two blocks
    await input.fill('Keep this block')
    await input.press('Enter')
    await input.fill('Remove this block')
    await input.press('Enter')

    await expect(page.getByText('Keep this block')).toBeVisible()
    await expect(page.getByText('Remove this block')).toBeVisible()

    // Delete only the second block
    const blockText = page.getByText('Remove this block')
    await blockText.hover()
    const deleteBtn = blockText.locator('..').getByRole('button', { name: 'Delete block' })
    await deleteBtn.click()

    // Second block gone, first block remains
    await expect(page.getByText('Remove this block')).not.toBeVisible()
    await expect(page.getByText('Keep this block')).toBeVisible()

    // Empty state should NOT return (one block remains)
    await expect(page.getByText('Add one below')).not.toBeVisible()
  })

  test('handles special characters in block content', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')

    await input.fill('<script>alert("xss")</script>')
    await input.press('Enter')

    // Content should render as text, not execute as HTML
    await expect(page.getByText('<script>alert("xss")</script>')).toBeVisible()

    // Also test quotes and ampersands
    await input.fill('Tom & Jerry said "hello" & it\'s fine')
    await input.press('Enter')

    await expect(page.getByText('Tom & Jerry said "hello"')).toBeVisible()
  })

  test('mock resets on page reload (test isolation)', async ({ page }) => {
    const input = page.getByPlaceholder('Write something...')

    // Create a block
    await input.fill('Session block')
    await input.press('Enter')
    await expect(page.getByText('Session block')).toBeVisible()

    // Reload the page — mock store is in-memory, should reset
    await page.reload()
    await expect(page.locator('header').getByText('Journal')).toBeVisible()

    // Block should be gone after reload
    await expect(page.getByText('Session block')).not.toBeVisible()
    await expect(page.getByText('Add one below')).toBeVisible()
  })
})
