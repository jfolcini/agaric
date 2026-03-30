import { expect, test } from '@playwright/test'

/**
 * Exhaustive E2E tests for inner links ([[ULID]] block links).
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") — 5 child blocks:
 *     GS_1: plain text
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: plain text
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *   PAGE_QUICK_NOTES ("Quick Notes") — 2 child blocks:
 *     QN_1: contains [[PAGE_GETTING_STARTED]] backlink
 *     QN_2: contains *italic* text
 *   3 tags: work, personal, idea
 */

/** Navigate to the page editor for a given page title. */
async function openPage(page: import('@playwright/test').Page, title: string) {
  await page.getByRole('button', { name: 'Pages' }).click()
  await page.getByText(title, { exact: true }).click()
  // Page editor shows title in an editable div
  await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
}

/** Wait for the app to fully boot (BootGate resolved, sidebar visible). */
async function waitForBoot(page: import('@playwright/test').Page) {
  await page.goto('/')
  // Wait for sidebar nav to appear (proves BootGate resolved)
  await expect(page.getByRole('button', { name: 'Journal' })).toBeVisible()
}

test.describe('Inner links — rendering', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('block_link tokens render as clickable chips with resolved page title', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // GS_2 has [[PAGE_QUICK_NOTES]] → should show "Quick Notes" chip
    const chip = page.locator('.block-link-chip', { hasText: 'Quick Notes' })
    await expect(chip).toBeVisible()
    await expect(chip).toHaveClass(/cursor-pointer/)
  })

  test('tag_ref tokens render as tag chips with resolved names', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // GS_4 has #[TAG_WORK] and #[TAG_PERSONAL]
    await expect(page.locator('.tag-ref-chip', { hasText: 'work' })).toBeVisible()
    await expect(page.locator('.tag-ref-chip', { hasText: 'personal' })).toBeVisible()
  })

  test('bold text renders with <strong> in static blocks', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // GS_5 has **Use the search panel**
    await expect(page.locator('strong', { hasText: 'Use the search panel' })).toBeVisible()
  })

  test('italic text renders with <em> in static blocks', async ({ page }) => {
    await openPage(page, 'Quick Notes')

    // QN_2 has *ideas*
    await expect(page.locator('em', { hasText: 'ideas' })).toBeVisible()
  })

  test('bidirectional links: Quick Notes links back to Getting Started', async ({ page }) => {
    await openPage(page, 'Quick Notes')

    // QN_1 has [[PAGE_GETTING_STARTED]] → should show "Getting Started" chip
    const chip = page.locator('.block-link-chip', { hasText: 'Getting Started' })
    await expect(chip).toBeVisible()
  })

  test('multiple link types coexist in a single page', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Should have at least: 1 block_link chip, 2 tag_ref chips, 1 bold element
    await expect(page.locator('.block-link-chip')).toHaveCount(1)
    const tagChips = page.locator('.tag-ref-chip')
    expect(await tagChips.count()).toBeGreaterThanOrEqual(2)
    await expect(page.locator('strong')).toHaveCount(1)
  })
})

test.describe('Inner links — navigation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('clicking a link chip navigates to the target page', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await page.locator('.block-link-chip', { hasText: 'Quick Notes' }).click()

    // Header should change to the target page
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()
  })

  test('back button returns to the previous page', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await page.locator('.block-link-chip', { hasText: 'Quick Notes' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()

    await page.getByRole('button', { name: 'Go back' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })

  test('multi-hop navigation: GS → QN → GS via link chips', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Hop 1: Getting Started → Quick Notes
    await page.locator('.block-link-chip', { hasText: 'Quick Notes' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()

    // Hop 2: Quick Notes → Getting Started (via QN_1 backlink)
    await page.locator('.block-link-chip', { hasText: 'Getting Started' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })

  test('deep navigation stack: forward 2 hops, back 2 hops', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Forward
    await page.locator('.block-link-chip', { hasText: 'Quick Notes' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()

    await page.locator('.block-link-chip', { hasText: 'Getting Started' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()

    // Back to Quick Notes
    await page.getByRole('button', { name: 'Go back' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Quick Notes' }),
    ).toBeVisible()

    // Back to first Getting Started
    await page.getByRole('button', { name: 'Go back' }).click()
    await expect(
      page.locator('[aria-label="Page title"]', { hasText: 'Getting Started' }),
    ).toBeVisible()
  })
})

/** Click a block to enter edit mode and wait for the TipTap editor. */
async function focusBlock(page: import('@playwright/test').Page, index = 0) {
  await page.locator('.block-static').nth(index).click()
  // Wait for the TipTap editor to mount (contenteditable div inside .block-editor)
  const editor = page.locator('.block-editor [contenteditable="true"]')
  await expect(editor).toBeVisible({ timeout: 3000 })
  // Focus the contenteditable
  await editor.focus()
}

/** Type [[ to trigger the link picker inside the focused editor. */
async function typeLinkTrigger(page: import('@playwright/test').Page) {
  // Move to end of content, then type [[
  await page.keyboard.press('End')
  await page.keyboard.type(' [[', { delay: 30 })
  // Wait for the suggestion popup
  await expect(page.locator('.suggestion-list')).toBeVisible({ timeout: 5000 })
}

test.describe('Inner links — [[ picker', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('[[ trigger opens suggestion popup', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await focusBlock(page)
    await expect(page.locator('.block-editor')).toBeVisible()

    await typeLinkTrigger(page)
  })

  test('picker shows existing pages', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await focusBlock(page)

    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })

    const list = page.locator('.suggestion-list')
    await expect(list).toBeVisible({ timeout: 3000 })

    // Should show at least Getting Started and Quick Notes
    await expect(list.locator('.suggestion-item')).toHaveCount(3) // 3 pages + daily
  })

  test('picker filters results as user types', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await focusBlock(page)

    await page.keyboard.type(' [[Quick', { delay: 30 })

    const list = page.locator('.suggestion-list')
    await expect(list).toBeVisible({ timeout: 3000 })

    // Should show Quick Notes
    await expect(list.locator('.suggestion-item', { hasText: 'Quick Notes' })).toBeVisible()
  })

  test('selecting a page from picker inserts a link chip', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await focusBlock(page)

    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })

    const list = page.locator('.suggestion-list')
    await expect(list).toBeVisible({ timeout: 3000 })

    // Click "Quick Notes" in the suggestion list
    await list.locator('.suggestion-item', { hasText: 'Quick Notes' }).click()

    // The editor should now contain a block-link chip
    const chip = page.locator('.block-editor .block-link-chip', { hasText: 'Quick Notes' })
    await expect(chip).toBeVisible({ timeout: 3000 })
  })

  test('picker shows "Create" option for non-matching queries', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await focusBlock(page)

    // Type [[ first to open picker, then type a query that doesn't match
    await page.keyboard.type(' [[', { delay: 30 })
    const list = page.locator('.suggestion-list')
    await expect(list).toBeVisible({ timeout: 5000 })

    // Type a non-matching query
    await page.keyboard.type('zzz_nonexistent', { delay: 20 })
    await page.waitForTimeout(200)

    // Should show create option
    await expect(list.locator('.suggestion-item', { hasText: 'Create' })).toBeVisible()
  })

  test('Escape dismisses the picker without inserting', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await focusBlock(page)

    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })
    await expect(page.locator('.suggestion-list')).toBeVisible({ timeout: 3000 })

    await page.keyboard.press('Escape')

    // Popup should be gone
    await expect(page.locator('.suggestion-popup')).not.toBeVisible()
  })

  test('keyboard navigation: ArrowDown + Enter selects item', async ({ page }) => {
    await openPage(page, 'Getting Started')

    await focusBlock(page)

    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })
    await expect(page.locator('.suggestion-list')).toBeVisible({ timeout: 3000 })

    // Arrow down to select second item, then Enter
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    // A link chip should have been inserted (exact page depends on order)
    await expect(page.locator('.block-editor .block-link-chip')).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Inner links — link persistence', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('link chip persists in static view after editor closes', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Count existing link chips before our edit
    const chipsBefore = await page.locator('.block-link-chip', { hasText: 'Quick Notes' }).count()

    // Click a block to edit
    await focusBlock(page)

    // Insert a link
    await page.keyboard.press('End')
    await page.keyboard.type(' [[', { delay: 30 })
    const list = page.locator('.suggestion-list')
    await expect(list).toBeVisible({ timeout: 5000 })
    await list.locator('.suggestion-item', { hasText: 'Quick Notes' }).click()
    await expect(
      page.locator('.block-editor .block-link-chip', { hasText: 'Quick Notes' }),
    ).toBeVisible({ timeout: 3000 })

    // Press Enter to save and close editor
    await page.keyboard.press('Enter')

    // Should have one MORE "Quick Notes" chip than before
    await expect(page.locator('.block-link-chip', { hasText: 'Quick Notes' })).toHaveCount(
      chipsBefore + 1,
      { timeout: 3000 },
    )
  })

  test('link survives page navigation and return', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Verify the existing link is visible
    const chip = page.locator('.block-link-chip', { hasText: 'Quick Notes' })
    await expect(chip).toBeVisible()

    // Navigate away to another sidebar view (use exact match to avoid the Tags tab button)
    await page.getByRole('button', { name: 'Tags', exact: true }).first().click()
    await expect(page.locator('[data-testid="header-label"]', { hasText: 'Tags' })).toBeVisible()

    // Navigate back to Getting Started
    await openPage(page, 'Getting Started')

    // Link should still be there
    await expect(page.locator('.block-link-chip', { hasText: 'Quick Notes' })).toBeVisible()
  })
})

test.describe('Inner links — Add block button position', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Add block button is above the detail panel', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Click a block to make the detail panel appear
    await focusBlock(page)

    // The Add block button should exist
    const addBtn = page.getByRole('button', { name: 'Add block' })
    await expect(addBtn).toBeVisible()

    // Click Backlinks tab to open the detail panel
    await page.locator('.detail-tab-backlinks').click()

    // Both should be visible
    await expect(addBtn).toBeVisible()
    await expect(page.locator('.detail-panel')).toBeVisible()

    // Add block button should be ABOVE the detail panel in the DOM
    const addBtnBox = await addBtn.boundingBox()
    const detailBox = await page.locator('.detail-panel').boundingBox()
    if (addBtnBox && detailBox) {
      expect(addBtnBox.y).toBeLessThan(detailBox.y)
    }
  })
})
