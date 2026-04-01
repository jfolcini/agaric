import { expect, test } from '@playwright/test'

/**
 * E2E tests for block-level undo/redo (#136).
 *
 * Block-level undo (Ctrl+Z when NOT inside contentEditable) calls
 * undoPageOp via the useUndoShortcuts hook. The mock reverses the
 * last operation. Since the frontend doesn't auto-refresh blocks
 * after undo, we navigate away and back to trigger a re-fetch from
 * the mock's updated state.
 *
 * Seed data: see tauri-mock.ts SEED_IDS.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForBoot(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
}

async function openPage(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByText(title, { exact: true }).click()
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

/** Navigate away and back to force BlockTree to re-fetch from mock. */
async function reopenPage(page: import('@playwright/test').Page, title: string) {
  // Navigate to Status (a simple view that always shows "Status" in header)
  await page.getByRole('button', { name: 'Status' }).click()
  await expect(page.locator('[data-testid="header-label"]')).toContainText('Status')
  await openPage(page, title)
}

/**
 * Escape any contentEditable / input focus so the next Ctrl+Z
 * is handled by useUndoShortcuts (which skips contentEditable targets).
 */
async function blurEditors(page: import('@playwright/test').Page) {
  await page.keyboard.press('Escape')
  // Programmatically blur the active element so focus is on document.body
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
  })
  // Wait until no contenteditable or input is focused
  await page.waitForFunction(
    () => {
      const el = document.activeElement
      return (
        !el ||
        el === document.body ||
        (!el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')
      )
    },
    { timeout: 2000 },
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Block-level undo/redo', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('undo reverses block creation', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('.sortable-block').count()

    // Create a new block
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore + 1, {
      timeout: 3000,
    })

    // Escape out of the editor so Ctrl+Z hits useUndoShortcuts
    await blurEditors(page)

    // Press Ctrl+Z — triggers block-level undo (useUndoShortcuts)
    await page.keyboard.press('Control+z')

    // Wait for the "Undone" toast to confirm undo fired
    await expect(page.getByText('Undone')).toBeVisible({ timeout: 3000 })

    // Navigate away and back to re-fetch blocks from mock's updated state
    await reopenPage(page, 'Getting Started')

    // Block count should be back to original
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore, {
      timeout: 3000,
    })
  })

  test('undo reverses block deletion', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('.sortable-block').count()
    expect(countBefore).toBeGreaterThan(0)

    // Delete the first block via hover button
    const firstBlock = page.locator('.sortable-block').first()
    await firstBlock.hover()
    const deleteBtn = firstBlock.getByRole('button', { name: 'Delete block' })
    await expect(deleteBtn).toBeVisible({ timeout: 3000 })
    await deleteBtn.click()

    // Verify block was deleted
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore - 1, {
      timeout: 3000,
    })

    // Escape and blur out of any contentEditable
    await blurEditors(page)

    // Press Ctrl+Z — triggers block-level undo
    await page.keyboard.press('Control+z')
    await expect(page.getByText('Undone')).toBeVisible({ timeout: 3000 })

    // Navigate away and back to re-fetch from mock
    await reopenPage(page, 'Getting Started')

    // Block count should be restored
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore, {
      timeout: 3000,
    })
  })

  test('redo re-applies after undo', async ({ page }) => {
    await openPage(page, 'Getting Started')

    const countBefore = await page.locator('.sortable-block').count()

    // Create a new block
    await page.getByRole('button', { name: 'Add block' }).click()
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore + 1, {
      timeout: 3000,
    })

    // Escape and blur out of any contentEditable
    await blurEditors(page)

    // Press Ctrl+Z — triggers undo
    await page.keyboard.press('Control+z')
    await expect(page.getByText('Undone')).toBeVisible({ timeout: 3000 })

    // Now redo with Ctrl+Y
    await page.keyboard.press('Control+y')
    await expect(page.getByText('Redone')).toBeVisible({ timeout: 3000 })

    // Navigate away and back to verify
    await reopenPage(page, 'Getting Started')

    // Block should be back (countBefore + 1)
    await expect(page.locator('.sortable-block')).toHaveCount(countBefore + 1, {
      timeout: 3000,
    })
  })
})
