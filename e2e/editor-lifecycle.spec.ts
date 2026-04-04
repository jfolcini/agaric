import { expect, test } from '@playwright/test'

/**
 * Editor lifecycle: CRUD operations, navigation, persistence.
 * All block operations use the "Getting Started" seed page.
 *
 * Key selectors:
 * - Static blocks: `button` with `aria-label="Edit block"` (class `.block-static`)
 * - TipTap editor: `[role="textbox"][aria-label="Block editor"]` (contenteditable)
 * - Sortable wrapper: `.sortable-block`
 * - Enter saves; Escape discards.
 */

async function openGettingStarted(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByText('Getting Started').click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible({ timeout: 5000 })
}

/** Click "Add block", wait for the TipTap editor to appear, type text, press Enter to save. */
async function addBlock(page: import('@playwright/test').Page, text: string) {
  await page.getByRole('button', { name: /add block/i }).click()
  const editor = page.getByRole('textbox', { name: 'Block editor' })
  await expect(editor).toBeVisible({ timeout: 5000 })
  await editor.pressSequentially(text, { delay: 30 })
  await editor.press('Enter')
  // Wait for the static block with the new text to appear
  await expect(page.getByText(text)).toBeVisible()
}

test.describe('Editor lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
  })

  test('Getting Started page loads with seed blocks', async ({ page }) => {
    await openGettingStarted(page)
    // Seed page has blocks — verify at least one is visible
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })

  test('creates a block via the Add block button', async ({ page }) => {
    await openGettingStarted(page)
    const initialCount = await page.locator('[data-testid="sortable-block"]').count()

    await addBlock(page, 'Hello from E2E')

    // Verify block count increased
    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(initialCount + 1)
    await expect(page.getByText('Hello from E2E')).toBeVisible()
  })

  test('creates multiple blocks', async ({ page }) => {
    await openGettingStarted(page)
    const initialCount = await page.locator('[data-testid="sortable-block"]').count()

    await addBlock(page, 'Block A')
    await addBlock(page, 'Block B')

    await expect(page.locator('[data-testid="sortable-block"]')).toHaveCount(initialCount + 2)
    await expect(page.getByText('Block A')).toBeVisible()
    await expect(page.getByText('Block B')).toBeVisible()
  })

  test('clicks a block to edit it inline', async ({ page }) => {
    await openGettingStarted(page)

    // Click the first seed block to focus it
    const firstBlock = page.getByRole('button', { name: 'Edit block' }).first()
    const originalText = await firstBlock.textContent()
    await firstBlock.click()

    // TipTap editor should appear
    const editor = page.getByRole('textbox', { name: 'Block editor' })
    await expect(editor).toBeVisible()

    // Press Escape to discard and unfocus without changing
    await editor.press('Escape')
    await expect(page.getByText(originalText?.trim())).toBeVisible()
  })

  test('deletes a block via the delete button', async ({ page }) => {
    await openGettingStarted(page)

    // Create a block to delete
    await addBlock(page, 'Delete me')

    // Hover over the block to reveal delete button
    const block = page.locator('[data-testid="sortable-block"]').filter({ hasText: 'Delete me' })
    await block.hover()

    // Click the delete button
    const deleteBtn = block.getByRole('button', { name: /delete block/i })
    await deleteBtn.click()

    // Verify block is gone
    await expect(page.getByText('Delete me')).not.toBeVisible()
  })

  test('navigates between sidebar views', async ({ page }) => {
    // Navigate to Tags
    await page.getByRole('button', { name: 'Tags' }).click()
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

    // Navigate back to Journal (no header label — has mode tabs instead)
    await page.getByRole('button', { name: 'Journal' }).click()
    await expect(page.getByRole('tab', { name: /daily/i })).toBeVisible()
  })

  test('pages view allows creating a new page', async ({ page }) => {
    await page.getByRole('button', { name: 'Pages' }).click()
    await expect(page.locator('header').getByText('Pages')).toBeVisible()

    const input = page.getByPlaceholder('New page name...')
    await input.fill('E2E Test Page')
    await input.press('Enter')

    // New page should appear in the list
    await expect(page.getByText('E2E Test Page')).toBeVisible()
  })

  test('blocks persist within the same page session', async ({ page }) => {
    await openGettingStarted(page)

    await addBlock(page, 'Persistent block')

    // Navigate away and back
    await page.getByRole('button', { name: 'Journal' }).click()
    await expect(page.getByRole('tab', { name: /daily/i })).toBeVisible()

    await openGettingStarted(page)

    // Block should still be there (mock state persists within session)
    await expect(page.getByText('Persistent block')).toBeVisible()
  })

  test('handles special characters in block content', async ({ page }) => {
    await openGettingStarted(page)

    await addBlock(page, 'Special: & "quotes" \'apos\'')

    await expect(page.getByText('Special: & "quotes" \'apos\'')).toBeVisible()
  })

  test('mock resets on page reload (test isolation)', async ({ page }) => {
    await openGettingStarted(page)

    await addBlock(page, 'Session block')

    // Reload the page — mock state resets
    await page.reload()
    await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()

    // Navigate back to Getting Started
    await openGettingStarted(page)

    // The session block should be gone (mock reset)
    await expect(page.getByText('Session block')).not.toBeVisible()
    // But seed blocks should be back
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })
})
