import { expect, test } from './helpers'

/**
 * Editor lifecycle: CRUD operations, navigation, persistence.
 * All block operations use the "Getting Started" seed page.
 *
 * Key selectors:
 * - Static blocks: `[data-testid="block-static"]` div (passive container after MAINT-162 — no role/aria-label)
 * - TipTap editor: `[role="textbox"][aria-label="Block editor"]` (contenteditable)
 * - Sortable wrapper: `[data-testid="sortable-block"]`
 * - Enter saves; Escape discards.
 */

async function openGettingStarted(page: import('@playwright/test').Page) {
  await page
    .locator('[data-slot="sidebar"]')
    .getByRole('button', { name: 'Pages', exact: true })
    .click()
  // Scope to the page list so we don't match the page-title textbox or a
  // block-link-chip that also renders "Getting Started" (strict-mode
  // violation under parallel load — TEST-3 flake, session 679).
  await page.locator('[data-page-item]').filter({ hasText: 'Getting Started' }).first().click()
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
  // Enter saves the just-typed block AND opens a fresh empty sibling
  // editor (`use-block-keyboard.ts` "Enter: save + create new sibling"). The
  // tests care about the content block only; dismiss the empty sibling with
  // Escape so it doesn't count toward the sortable-block total.
  const freshEditor = page.getByRole('textbox', { name: 'Block editor' })
  if (await freshEditor.isVisible().catch(() => false)) {
    await freshEditor.press('Escape')
  }
}

test.describe('Editor lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
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

    // Click the first seed block to focus it. Static blocks are passive
    // div containers (MAINT-162), located via data-testid.
    const firstBlock = page.locator('[data-testid="block-static"]').first()
    const originalText = (await firstBlock.textContent())?.trim()
    if (!originalText) throw new Error('seed block had no text content')
    await firstBlock.click()

    // TipTap editor should appear
    const editor = page.getByRole('textbox', { name: 'Block editor' })
    await expect(editor).toBeVisible()

    // Press Escape to discard and unfocus without changing
    await editor.press('Escape')
    await expect(page.getByText(originalText)).toBeVisible()
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
    // Use the dedicated `header-label` testid (the App.tsx shell header)
    // so the assertions are unambiguous — TrashView, StatusPanel, and
    // friends now render their own `<header>` via `FeaturePageHeader`,
    // which made the previous `locator('header').getByText(...)` race
    // against an `<h1>` carrying the same text inside a sibling `<header>`.
    const headerLabel = page.getByTestId('header-label')

    // Navigate to Tags
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Tags', exact: true })
      .click()
    await expect(headerLabel).toHaveText('Tags')

    // Navigate to Trash
    await page.getByRole('button', { name: /^Trash/ }).click()
    await expect(headerLabel).toHaveText('Trash')

    // Navigate to Status
    await page.getByRole('button', { name: 'Status', exact: true }).click()
    await expect(headerLabel).toHaveText('Status')

    // (Conflicts nav-item removed in Session 700 / PEND-09 Phase 5.)

    // Navigate back to Journal (no header label — has mode tabs instead)
    await page.getByRole('button', { name: 'Journal', exact: true }).click()
    await expect(page.getByRole('tab', { name: /daily/i })).toBeVisible()
  })

  test('pages view allows creating a new page', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')

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
    await page.getByRole('button', { name: 'Journal', exact: true }).click()
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

    // Reload the page — mock state resets.
    // Under heavy parallel load the dev server can still be serving stale
    // bundles when reload resolves; wait for the network to settle so the
    // app shell is fully hydrated before asserting (TEST-3 flake).
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible({
      timeout: 10000,
    })

    // Navigate back to Getting Started
    await openGettingStarted(page)

    // The session block should be gone (mock reset)
    await expect(page.getByText('Session block')).not.toBeVisible()
    // But seed blocks should be back
    await expect(page.locator('[data-testid="sortable-block"]').first()).toBeVisible()
  })
})
