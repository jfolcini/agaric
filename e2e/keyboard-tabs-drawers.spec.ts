import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E coverage for keyboard-driven TAB MANAGEMENT and BLOCK DRAWERS (#1172).
 *
 * These shortcut paths were previously covered only by unit tests
 * (src/hooks/__tests__/useAppKeyboardShortcuts.test.ts and friends). This
 * spec asserts the *user-visible* effect of each chord in the running app:
 * the TabBar gaining/losing tabs and moving its active-selection, and the
 * per-block side drawers (properties, history) + the date picker becoming
 * visible for the focused block.
 *
 * Harness conventions reused verbatim from keyboard-shortcuts.spec.ts:
 *   - waitForBoot(page) in beforeEach (loads /, waits for the Journal button).
 *   - openPage(page, title) to enter a page editor (seeds the active tab's
 *     pageStack — required for Ctrl+T `openInNewTab`).
 *   - focusBlock(page, n) to mount the TipTap editor on a block (required for
 *     the drawer/date-picker chords, which gate on a focused, store-owned
 *     block).
 *   - chords pressed as Control-down → key → Control-up so the React/window
 *     keydown listeners see the real modifier state.
 *
 * Viewport: the default project is Desktop Chrome (playwright.config.ts), so
 * `useIsMobile()` is false and the TabBar + tab shortcuts are live (the bar
 * and the openInNewTab/closeActiveTab/nextTab/previousTab handlers are
 * desktop-only — they short-circuit on touch viewports).
 */

// ===========================================================================
// 1. Tab management shortcuts
//
// The TabBar autohides while a single tab is open (TabBar.tsx: `if
// (tabs.length <= 1) return null`), so the bar only renders once a second tab
// exists. `openInNewTab` (Ctrl+T) duplicates the active tab's top page, which
// is exactly what surfaces the bar from a fresh single-tab boot.
// ===========================================================================

test.describe('Tab management shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+T opens a new tab — it appears and becomes active', async ({ page }) => {
    // Enter a page editor so the active tab has a non-empty pageStack
    // (Ctrl+T no-ops + toasts when the active tab has no top page).
    await openPage(page, 'Getting Started')

    // Single tab → TabBar is autohidden (no role="tablist" rendered).
    await expect(page.getByRole('tablist')).toHaveCount(0)

    // Press Ctrl+T → openInNewTab duplicates the current page into a new tab.
    await page.keyboard.down('Control')
    await page.keyboard.press('t')
    await page.keyboard.up('Control')

    // The TabBar now renders with exactly two tabs.
    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(2)

    // The newly opened tab is the active one (openInNewTab switches to it),
    // i.e. the LAST tab carries aria-selected="true".
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
  })

  test('Ctrl+W closes the active tab — count drops and focus moves', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Open a second tab so the bar is visible and there is something to close.
    await page.keyboard.down('Control')
    await page.keyboard.press('t')
    await page.keyboard.up('Control')

    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(2)
    // The second (new) tab is active before we close it.
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    // Press Ctrl+W → closeActiveTab removes the active tab.
    await page.keyboard.down('Control')
    await page.keyboard.press('w')
    await page.keyboard.up('Control')

    // Back down to a single tab → the bar autohides again (count drops to 0
    // rendered tabs), proving the active tab was removed and focus collapsed
    // onto the lone remaining tab.
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByRole('tablist')).toHaveCount(0)

    // The remaining page is still the editor we opened (focus moved to the
    // surviving tab, not a blank view).
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
  })

  test('Ctrl+Tab advances the active tab to the next one', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Open a second tab. After openInNewTab the new (index 1) tab is active.
    await page.keyboard.down('Control')
    await page.keyboard.press('t')
    await page.keyboard.up('Control')

    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    // Press Ctrl+Tab → nextTab wraps from index 1 back to index 0.
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await page.keyboard.up('Control')

    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false')

    // Press Ctrl+Tab again → advances forward from index 0 to index 1.
    await page.keyboard.down('Control')
    await page.keyboard.press('Tab')
    await page.keyboard.up('Control')

    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
  })

  test('Ctrl+Shift+Tab moves the active tab back to the previous one', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Open a second tab (index 1 active).
    await page.keyboard.down('Control')
    await page.keyboard.press('t')
    await page.keyboard.up('Control')

    const tabs = page.getByRole('tab')
    await expect(tabs).toHaveCount(2)
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

    // Press Ctrl+Shift+Tab → previousTab wraps from index 1 to index 0.
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Tab')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'false')

    // Press Ctrl+Shift+Tab again → wraps backward from index 0 to index 1.
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Tab')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false')
  })
})

// ===========================================================================
// 2. Block drawer shortcuts
//
// Each chord is handled while a block is focused: Ctrl+Shift+P / Ctrl+Shift+Y
// are editor KEY_RULES (use-block-keyboard.ts `openPropertiesDrawer` /
// `openBlockHistory`) and Ctrl+Shift+D is the document-level `openDatePicker`
// listener (useBlockTreeKeyboardShortcuts.ts), gated on `storeOwnsBlock`. All
// three require a focused, store-owned block, so each test focuses a block
// first, then asserts the corresponding surface becomes visible.
// ===========================================================================

test.describe('Block drawer shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Shift+P opens the block properties drawer', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Press Ctrl+Shift+P → openPropertiesDrawer sets propertyDrawerBlockId,
    // mounting the BlockPropertyDrawerSheet for the focused block.
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('p')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // The drawer (a right-side Sheet) is visible with its "Block Properties"
    // title — the user-visible effect for the focused block.
    await expect(page.getByRole('dialog', { name: 'Block Properties' })).toBeVisible()
  })

  test('Ctrl+Shift+Y opens the block history drawer', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Press Ctrl+Shift+Y → openBlockHistory sets historyBlockId, mounting the
    // BlockHistorySheet for the focused block.
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('y')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // The history side-sheet is visible with its "Block History" title.
    await expect(page.getByRole('dialog', { name: 'Block History' })).toBeVisible()
  })

  test('Ctrl+Shift+D opens the date picker for the focused block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Press Ctrl+Shift+D → openDatePicker (document-level handler) opens the
    // floating BlockDatePicker in 'date' mode for the focused, owned block.
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('d')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // The date picker popup is visible (data-testid="date-picker-popup").
    await expect(page.getByTestId('date-picker-popup')).toBeVisible()
  })
})
