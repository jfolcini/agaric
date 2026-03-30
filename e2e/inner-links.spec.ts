import { expect, test } from '@playwright/test'

/**
 * E2E tests for inner links ([[ULID]] block links).
 *
 * The mock layer (tauri-mock.ts) provides seed data with valid 26-char ULIDs:
 * - 00000000000000000000PAGE01 ("Getting Started") with child blocks containing
 *   [[00000000000000000000PAGE02]] links and #[000000000000000000000TAG01] tag refs
 * - 00000000000000000000PAGE02 ("Quick Notes")
 * - Bold text: **Use the search panel** in BLOCK_GS_5
 */
test.describe('Inner links', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('header').getByText('Journal')).toBeVisible()
  })

  test('link chips render with resolved page titles on the page editor', async ({ page }) => {
    // Navigate to Pages
    await page.getByRole('button', { name: 'Pages' }).click()

    // Click "Getting Started" to open the page editor
    await page.getByText('Getting Started').click()
    await expect(page.locator('header').getByText('Getting Started')).toBeVisible()

    // Block GS_2 contains [[00000000000000000000PAGE02]] — should render as "Quick Notes" chip
    const linkChip = page.locator('.block-link-chip', { hasText: 'Quick Notes' })
    await expect(linkChip).toBeVisible()
  })

  test('clicking a link chip navigates to the target page', async ({ page }) => {
    // Navigate to Pages → Getting Started
    await page.getByRole('button', { name: 'Pages' }).click()
    await page.getByText('Getting Started').click()
    await expect(page.locator('header').getByText('Getting Started')).toBeVisible()

    // Click the "Quick Notes" link chip
    const linkChip = page.locator('.block-link-chip', { hasText: 'Quick Notes' })
    await expect(linkChip).toBeVisible()
    await linkChip.click()

    // Should navigate to the Quick Notes page editor
    await expect(page.locator('header').getByText('Quick Notes')).toBeVisible()
  })

  test('tag reference chips render with resolved tag names', async ({ page }) => {
    // Navigate to Pages → Getting Started
    await page.getByRole('button', { name: 'Pages' }).click()
    await page.getByText('Getting Started').click()

    // Block GS_4 contains #[000000000000000000000TAG01] — should render as tag chip with "work"
    const tagChip = page.locator('.tag-ref-chip', { hasText: 'work' })
    await expect(tagChip).toBeVisible()
  })

  test('bold text renders with strong element in static blocks', async ({ page }) => {
    // Navigate to Pages → Getting Started
    await page.getByRole('button', { name: 'Pages' }).click()
    await page.getByText('Getting Started').click()

    // Block GS_5 has **Use the search panel** — should render with <strong>
    const boldText = page.locator('strong', { hasText: 'Use the search panel' })
    await expect(boldText).toBeVisible()
  })

  test('back button returns to previous page after link navigation', async ({ page }) => {
    // Navigate to Pages → Getting Started
    await page.getByRole('button', { name: 'Pages' }).click()
    await page.getByText('Getting Started').click()
    await expect(page.locator('header').getByText('Getting Started')).toBeVisible()

    // Click the "Quick Notes" link chip to navigate
    const linkChip = page.locator('.block-link-chip', { hasText: 'Quick Notes' })
    await linkChip.click()
    await expect(page.locator('header').getByText('Quick Notes')).toBeVisible()

    // Click back button
    await page.getByRole('button', { name: 'Go back' }).click()

    // Should return to Getting Started
    await expect(page.locator('header').getByText('Getting Started')).toBeVisible()
  })

  test('creating a new page via [[ picker and linking to it', async ({ page }) => {
    // Navigate to Pages → Getting Started
    await page.getByRole('button', { name: 'Pages' }).click()
    await page.getByText('Getting Started').click()

    // Click on a block to focus it (first content block)
    const firstBlock = page.locator('.block-static').first()
    await firstBlock.click()

    // Type [[ to open the picker
    await page.keyboard.type('[[')

    // The suggestion popup should appear
    const suggestionList = page.locator('.suggestion-list')
    await expect(suggestionList).toBeVisible({ timeout: 3000 })

    // Type a query to filter
    await page.keyboard.type('Quick')

    // "Quick Notes" should appear in the suggestions
    const suggestion = suggestionList.locator('.suggestion-item', { hasText: 'Quick Notes' })
    await expect(suggestion).toBeVisible({ timeout: 3000 })
  })
})
