import {
  deleteBlockViaContextMenu,
  expect,
  focusBlock,
  openPage,
  saveBlock,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E coverage for the #1172 keyboard-collision gaps — shortcuts whose glyph
 * is shared between a global handler and the editor/TipTap keymap, where the
 * *resolved* action must differ by focus context. These assert the real,
 * user-visible surface in each context (rendered DOM only — never internals).
 *
 * The unit suites (useAppKeyboardShortcuts / useBlockTreeKeyboardShortcuts /
 * use-sidebar-keyboard / keyboard-config) already prove the routing tables in
 * isolation; this spec exercises the end-to-end browser path where the global
 * `window`/`document` listeners and the focused editor's keymap actually race.
 *
 * Collisions covered:
 *   1. Ctrl+K  — link popover (in editor) vs command palette (outside)
 *   2. Ctrl+B  — bold (in editor, sidebar must NOT toggle) vs sidebar toggle
 *   3. Ctrl+1/2 — heading level (in focused block) vs space switch (outside)
 *   4. List-view keyboard selection (Trash) — arrow/Space/Ctrl+A/Escape
 *
 * The mock (`tauri-mock/handlers.ts` `list_spaces`) seeds a single space
 * ("Personal"), so the OUTSIDE-editor branch of Ctrl+1/2 (switch space) is a
 * deliberate no-op there: index 1 is the current space and index 2 is
 * out-of-range. That branch is asserted as covered-at-unit-level
 * (useAppKeyboardShortcuts.test.ts); here we assert (a) the in-editor heading
 * branch produces <h1>/<h2>, and (b) the chord does nothing harmful outside
 * the editor (no navigation away from the view, no crash).
 */

// ===========================================================================
// 1. Ctrl+K — link popover (editor) vs command palette (outside)
// ===========================================================================

test.describe('Ctrl+K collision routing', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('caret inside the editor opens the link popover, NOT the command palette', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')

    // In-editor: TipTap's own Cmd+K link command wins — link popover opens.
    await expect(page.getByTestId('link-edit-popover')).toBeVisible()
    await expect(page.getByPlaceholder('https://...')).toBeVisible()
    // And the global palette must NOT have opened.
    await expect(page.getByTestId('command-palette-input')).toHaveCount(0)
  })

  test('focus outside any editor opens the command palette, NOT the link popover', async ({
    page,
  }) => {
    // Move focus out of any editor by clicking a sidebar nav button.
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')

    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')

    // Outside the editor: the global handler wins — command palette opens.
    await expect(page.getByTestId('command-palette-input')).toBeVisible()
    // And the editor link popover must NOT have opened.
    await expect(page.getByTestId('link-edit-popover')).toHaveCount(0)
  })
})

// ===========================================================================
// 2. Ctrl+B — bold (editor; sidebar stays) vs sidebar toggle (outside)
// ===========================================================================

test.describe('Ctrl+B collision routing', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('selection inside the editor bolds text and does NOT toggle the sidebar', async ({
    page,
  }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Sidebar starts expanded.
    const sidebar = page.locator('[data-slot="sidebar"]')
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')

    // Select all text, then Ctrl+B.
    await page.keyboard.press('Control+a')
    await page.keyboard.down('Control')
    await page.keyboard.press('b')
    await page.keyboard.up('Control')

    // Editor's Bold command wins — toolbar Bold reports pressed.
    const boldBtn = page.getByRole('button', { name: 'Bold' })
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'true')

    // The sidebar must remain expanded (the toggle was suppressed in-editor).
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')

    // Blur to static and confirm the text actually rendered bold (<strong>).
    await saveBlock(page)
    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('strong')).toBeVisible()
  })

  test('focus outside the editor toggles the sidebar visibility', async ({ page }) => {
    // Take focus out of any editor by clicking a sidebar nav button.
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')

    const sidebar = page.locator('[data-slot="sidebar"]')
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')

    // Outside the editor: the global toggleSidebar handler wins.
    await page.keyboard.down('Control')
    await page.keyboard.press('b')
    await page.keyboard.up('Control')
    await expect(sidebar).toHaveAttribute('data-state', 'collapsed')

    // Toggle back to prove it's a real visibility toggle, not a one-way close.
    await page.keyboard.down('Control')
    await page.keyboard.press('b')
    await page.keyboard.up('Control')
    await expect(sidebar).toHaveAttribute('data-state', 'expanded')
  })
})

// ===========================================================================
// 3. Ctrl+1 / Ctrl+2 — heading level (focused block) vs space switch (outside)
//
// The mock seeds ONE space, so the space-switch branch is a no-op here (index
// 1 == current, index 2 out-of-range). That branch is covered at unit level
// (useAppKeyboardShortcuts.test.ts `switchSpaceN`). Below we assert the
// in-editor heading branch (<h1>/<h2>) and that the chord is harmless outside.
// ===========================================================================

test.describe('Ctrl+1 / Ctrl+2 collision routing', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+1 on a focused block sets heading level 1 (<h1>)', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.down('Control')
    await page.keyboard.press('1')
    await page.keyboard.up('Control')

    // Blur to static so the heading node renders. (Ctrl+1 prepends "# " to the
    // block content via the slash `h1` handler; the static renderer emits <h1>.)
    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h1')).toBeVisible()
  })

  test('Ctrl+2 on a focused block sets heading level 2 (<h2>)', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.down('Control')
    await page.keyboard.press('2')
    await page.keyboard.up('Control')

    await saveBlock(page)

    const staticBlock = page
      .locator('[data-testid="sortable-block"]')
      .first()
      .locator('[data-testid="block-static"]')
    await expect(staticBlock.locator('h2')).toBeVisible()
  })

  test('Ctrl+1 outside any editor is a harmless no-op (single seeded space)', async ({ page }) => {
    // Move focus out of any editor and onto the Pages view.
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')

    // The space-switch handler short-circuits (target index 1 is the current
    // space). It must not navigate away, open a heading, or crash.
    await page.keyboard.down('Control')
    await page.keyboard.press('1')
    await page.keyboard.up('Control')

    // Still on Pages — no view change, no editor heading mutation.
    await expect(page.getByTestId('header-label')).toHaveText('Pages')
    // No stray heading element appeared in the (editor-less) view.
    await expect(page.locator('[data-testid="block-editor"]')).toHaveCount(0)
  })
})

// ===========================================================================
// 4. List-view keyboard selection (Trash) — arrow / Space / Ctrl+A / Escape
// ===========================================================================

test.describe('Trash list-view keyboard selection', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  /**
   * Seed the trash with two deleted blocks, then open the Trash view. Returns
   * once at least two `trash-item` rows are visible.
   */
  async function seedTrashWithTwoItems(page: import('@playwright/test').Page) {
    await openPage(page, 'Getting Started')

    // Delete two blocks via the context menu (same path as
    // features-coverage.spec.ts). The first row collapses out after each
    // delete, so re-target `.first()` each time.
    for (let i = 0; i < 2; i++) {
      const row = page.locator('[data-testid="sortable-block"]').first()
      await deleteBlockViaContextMenu(page, row)
    }

    // Navigate to Trash.
    await page.getByRole('button', { name: /^Trash/ }).click()
    await expect(page.locator('[data-testid="trash-item"]').nth(1)).toBeVisible()
  }

  test('Space selects the focused row; Escape clears the selection', async ({ page }) => {
    await seedTrashWithTwoItems(page)

    const rows = page.locator('[data-testid="trash-item"]')
    // focusedIndex defaults to 0 — the first row carries the focus ring.
    await expect(rows.first()).not.toHaveAttribute('aria-selected', 'true')

    // Space toggles selection of the focused (first) row.
    await page.keyboard.press('Space')
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
    // Selection toolbar reflects the count.
    await expect(page.getByText('1 selected')).toBeVisible()

    // Escape clears the selection.
    await page.keyboard.press('Escape')
    await expect(rows.first()).toHaveAttribute('aria-selected', 'false')
  })

  test('ArrowDown moves focus, then Space selects the second row', async ({ page }) => {
    await seedTrashWithTwoItems(page)

    const rows = page.locator('[data-testid="trash-item"]')

    // ArrowDown advances the focused index to the second row.
    await page.keyboard.press('ArrowDown')
    // The second row now owns the focus ring (tabIndex 0 when focused).
    await expect(rows.nth(1)).toHaveAttribute('tabindex', '0')
    await expect(rows.first()).toHaveAttribute('tabindex', '-1')

    // Space selects the now-focused second row (and NOT the first).
    await page.keyboard.press('Space')
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(rows.first()).not.toHaveAttribute('aria-selected', 'true')
  })

  test('Ctrl+A selects all rows; Escape clears them', async ({ page }) => {
    await seedTrashWithTwoItems(page)

    const rows = page.locator('[data-testid="trash-item"]')
    const total = await rows.count()
    expect(total).toBeGreaterThanOrEqual(2)

    // Ctrl+A selects every visible row.
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')

    for (let i = 0; i < total; i++) {
      await expect(rows.nth(i)).toHaveAttribute('aria-selected', 'true')
    }

    // Escape clears the whole selection.
    await page.keyboard.press('Escape')
    for (let i = 0; i < total; i++) {
      await expect(rows.nth(i)).toHaveAttribute('aria-selected', 'false')
    }
  })
})
