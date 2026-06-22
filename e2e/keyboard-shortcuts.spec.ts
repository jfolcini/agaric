import { expect, focusBlock, openPage, test, waitForBoot } from './helpers'

/**
 * E2E tests for keyboard shortcuts.
 *
 * Covers formatting shortcuts, block navigation, block organization,
 * task/priority shortcuts, global shortcuts, and link shortcuts.
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_GETTING_STARTED ("Getting Started") -- 5 child blocks:
 *     GS_1: "Welcome to Agaric! This is your personal knowledge base."
 *     GS_2: contains [[PAGE_QUICK_NOTES]] link
 *     GS_3: "Create new blocks by pressing Enter at the end of any block."
 *     GS_4: contains #[TAG_WORK] and #[TAG_PERSONAL] tag refs
 *     GS_5: contains **bold** text
 *   PAGE_QUICK_NOTES ("Quick Notes") -- 2 child blocks:
 *     QN_1: contains [[PAGE_GETTING_STARTED]] backlink
 *     QN_2: contains *italic* text
 */

// ===========================================================================
// 1. Formatting shortcuts (in focused editor)
// ===========================================================================

test.describe('Formatting shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+B toggles bold on selected text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text in the editor
    await page.keyboard.press('Control+a')

    // Press Ctrl+B to toggle bold
    await page.keyboard.down('Control')
    await page.keyboard.press('b')
    await page.keyboard.up('Control')

    // Verify the Bold button shows aria-pressed="true"
    const boldBtn = page.getByRole('button', { name: 'Bold' })
    await expect(boldBtn).toHaveAttribute('aria-pressed', 'true')
  })

  test('Ctrl+I toggles italic on selected text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    // Select all text in the editor
    await page.keyboard.press('Control+a')

    // Press Ctrl+I to toggle italic
    await page.keyboard.down('Control')
    await page.keyboard.press('i')
    await page.keyboard.up('Control')

    // Verify the Italic button shows aria-pressed="true"
    const italicBtn = page.getByRole('button', { name: 'Italic' })
    await expect(italicBtn).toHaveAttribute('aria-pressed', 'true')
  })

  test('Ctrl+Shift+C toggles code block', async ({ page }) => {
    await openPage(page, 'Getting Started')
    const editor = await focusBlock(page)

    // Press Ctrl+Shift+C to toggle code block
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('c')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // #1960 — the toolbar no longer has a code button (Code block lives in the
    // Turn into menu), so verify the code block on the editor itself.
    await expect(editor.locator('pre')).toBeVisible()
  })
})

// ===========================================================================
// 2. Block navigation
// ===========================================================================

test.describe('Block navigation', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Arrow Down at end moves to next block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Focus the first block
    await focusBlock(page, 0)

    // Get text of first block for comparison later
    const firstBlockText = await page
      .locator('[data-testid="block-editor"] [contenteditable="true"]')
      .textContent()

    // Move to end and press ArrowDown to navigate to next block
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowDown')

    // Wait for the editor to appear on the second block
    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(editor).toBeVisible()

    // The editor content should be different from the first block
    const newText = await editor.textContent()
    expect(newText).not.toBe(firstBlockText)
  })

  test('Arrow Up at start moves to previous block', async ({ page }) => {
    // Use Quick Notes page (2 blocks with simpler content)
    await openPage(page, 'Quick Notes')

    // Click the second block directly (skip the editor.focus() from focusBlock helper)
    await page.locator('[data-testid="block-static"]').nth(1).click()
    const editor = page.locator('[data-testid="block-editor"] [contenteditable="true"]')
    await expect(editor).toBeVisible()
    const secondBlockId = await page
      .locator('[data-testid="block-editor"]')
      .getAttribute('data-block-id')

    // Ensure editor is focused and interactive (React keydown listener attached)
    await editor.focus()
    await expect(editor).toBeFocused()

    // Navigate to previous block via Home+ArrowUp
    // Retry until the React useEffect keydown handler is ready
    await expect(async () => {
      await page.keyboard.press('Home')
      await page.keyboard.press('ArrowUp')
      await expect(
        page.locator(`[data-testid="block-editor"]:not([data-block-id="${secondBlockId}"])`),
      ).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 5000 })
  })
})

// ===========================================================================
// 3. Block organization
// ===========================================================================

test.describe('Block organization', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Shift+ArrowRight indents block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Use the third block (index 2, GS_3 — plain text, avoids link chips in GS_2)
    const targetBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const initialPadding = await targetBlock.evaluate(
      (el) => window.getComputedStyle(el).paddingLeft,
    )

    // Focus the third block
    await focusBlock(page, 2)

    // Press Ctrl+Shift+ArrowRight to indent
    await page.keyboard.press('Control+Shift+ArrowRight')

    // Wait for indent to apply and verify the block now has increased paddingLeft
    await expect
      .poll(async () => {
        const p = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
        return Number.parseInt(p, 10)
      })
      .toBeGreaterThan(Number.parseInt(initialPadding, 10))
  })

  test('Ctrl+Shift+ArrowLeft dedents block', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Capture pre-indent padding for the third block
    const targetBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const basePadding = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)

    // Focus the third block (index 2, GS_3) and indent it first
    await focusBlock(page, 2)
    await page.keyboard.press('Control+Shift+ArrowRight')

    // Wait for indent to apply (padding increases from base)
    await expect
      .poll(async () => {
        const p = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
        return Number.parseInt(p, 10)
      })
      .toBeGreaterThan(Number.parseInt(basePadding, 10))

    // Get the indented paddingLeft
    const indentedPadding = await targetBlock.evaluate(
      (el) => window.getComputedStyle(el).paddingLeft,
    )

    // Now press Ctrl+Shift+ArrowLeft to dedent (editor should still be open)
    await page.keyboard.press('Control+Shift+ArrowLeft')

    // Wait for dedent to apply and verify paddingLeft decreased
    await expect
      .poll(async () => {
        const p = await targetBlock.evaluate((el) => window.getComputedStyle(el).paddingLeft)
        return Number.parseInt(p, 10)
      })
      .toBeLessThan(Number.parseInt(indentedPadding, 10))
  })

  test('Ctrl+Shift+ArrowUp moves block up', async ({ page }) => {
    // Use Quick Notes (2 blocks — simpler and more reliable)
    await openPage(page, 'Quick Notes')

    // Capture original block order via data-block-id
    const blocks = page.locator('[data-testid="sortable-block"]')
    const originalSecondId = (await blocks.nth(1).getAttribute('data-block-id')) ?? ''

    // Focus the second block and move it up
    await focusBlock(page, 1)

    // Press Ctrl+Shift+ArrowUp to move block up
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // Press Escape to exit editor
    await page.keyboard.press('Escape')

    // Wait for the reorder to settle — auto-retrying attribute assertion
    // After MoveUp, the second block should now be first
    await expect(blocks.nth(0)).toHaveAttribute('data-block-id', originalSecondId, {
      timeout: 5000,
    })
  })

  test('Ctrl+Shift+ArrowDown moves block down', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Get text of the first two blocks in static view
    const secondBlockText = await page.locator('[data-testid="block-static"]').nth(1).textContent()

    // Focus the first block
    await focusBlock(page, 0)

    // Press Ctrl+Shift+ArrowDown to move block down
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    // Wait for the reorder to take effect, then press Escape to leave editing mode
    await page.keyboard.press('Escape')

    // Wait for reorder to settle and verify blocks swapped: old second block is now first
    await expect(page.locator('[data-testid="block-static"]').nth(0)).toHaveText(secondBlockText, {
      timeout: 5000,
    })
  })
})

// ===========================================================================
// 4. Task/Priority shortcuts
// ===========================================================================

test.describe('Task and priority shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+Enter cycles task state', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Focus the first block
    await focusBlock(page)

    // The first sortable block before Ctrl+Enter should have the empty checkbox
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock.locator('[data-testid="task-checkbox-empty"]')).toBeVisible()

    // Press Ctrl+Enter to cycle task state: none -> TODO
    await page.keyboard.down('Control')
    await page.keyboard.press('Enter')
    await page.keyboard.up('Control')

    // The empty checkbox should disappear (task state changed)
    await expect(firstBlock.locator('[data-testid="task-checkbox-empty"]')).not.toBeVisible({
      timeout: 5000,
    })
  })

  test('Ctrl+. toggles collapse on block with children', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Indent the fourth block (index 3, GS_4) under the third (index 2, GS_3 plain text)
    await focusBlock(page, 3)
    await page.keyboard.press('Control+Shift+ArrowRight')

    // Close the editor so only the document-level Ctrl+. handler fires
    // (Avoids double-toggle: both editor-level and document-level handlers
    //  call toggleCollapse, which would net to zero change.)
    await page.keyboard.press('Escape')

    // Wait for editor to close after Escape
    await expect(page.locator('[data-testid="block-editor"]')).not.toBeVisible()

    // The third block (GS_3) should now have a collapse chevron (hasChildren)
    const parentBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const chevron = parentBlock.locator('[data-testid="collapse-toggle"]')
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')

    // Click the collapse chevron to toggle collapse. #1243: an EXPANDED
    // parent's chevron is hover-revealed (opacity-0 / pointer-events-none at
    // rest), so hover the row first to make it actionable — matching how a
    // mouse user reaches it.
    await parentBlock.hover()
    await chevron.click()

    // Verify the chevron now shows collapsed (aria-expanded=false)
    await expect(chevron).toHaveAttribute('aria-expanded', 'false')
  })

  // #922 f6 — keyboard-driven collapse. The test above CLICKS the chevron;
  // this one exercises the actual Ctrl+. (`collapseExpand`) key path, which
  // the click-based test never touched.
  //
  // Key model (verified against src): pressing Ctrl+. is handled by the
  // EDITOR keymap (`src/editor/use-block-keyboard.ts` `collapseExpand` rule)
  // while a block is focused. That handler runs on the editor container in the
  // CAPTURE phase and calls `stopPropagation()` after `preventDefault()`
  // (use-block-keyboard.ts:405-410), so the document-level collapse listener
  // in `useBlockTreeKeyboardShortcuts` never also fires — no double-toggle.
  // The document-level handler additionally requires `focusedBlockId` to be
  // set and `storeOwnsBlock` to pass (the #713 ownership gate), so the parent
  // MUST stay focused — escaping out (which calls `setFocused(null)`) would
  // make BOTH handlers no-op. We therefore keep the parent focused and press
  // the chord, asserting a single net toggle each press.
  test('Ctrl+. (keyboard) toggles collapse on the focused parent (#713 gate)', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Indent GS_4 (index 3) under GS_3 (index 2, plain text) so GS_3 becomes a
    // parent with one child. focusBlock(page, 3) is safe here (no other block
    // focused yet), and the indent shortcut re-parents under the prev sibling.
    await focusBlock(page, 3)
    await page.keyboard.press('Control+Shift+ArrowRight')

    // The third block (GS_3) now owns a collapse chevron (hasChildren).
    const parentBlock = page.locator('[data-testid="sortable-block"]').nth(2)
    const chevron = parentBlock.locator('[data-testid="collapse-toggle"]')
    await expect(chevron).toBeVisible()
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')

    // Record the child's block id so we can assert it hides/reappears. GS_4 is
    // the indented block — capture it from the 4th sortable-block wrapper
    // (wrappers render regardless of focus state, unlike block-static).
    const childId = await page
      .locator('[data-testid="sortable-block"]')
      .nth(3)
      .getAttribute('data-block-id')
    expect(childId).toBeTruthy()
    const childBlock = page.locator(`[data-testid="sortable-block"][data-block-id="${childId}"]`)
    await expect(childBlock).toBeVisible()

    // Focus the PARENT (GS_3) in the editor — keyboard collapse only fires for
    // the focused, store-owned block. Switching focus from GS_4 to GS_3 goes
    // via Escape first to drain GS_4's blur path deterministically (matches the
    // breadcrumb-navigation.spec.ts focus-switch convention), then we re-enter
    // GS_3 so it is the focused/owned block when Ctrl+. fires.
    await page.keyboard.press('Escape')
    await focusBlock(page, 2)

    // Press Ctrl+Period → collapse. aria-expanded flips to false; child hides.
    await page.keyboard.press('Control+Period')
    await expect(chevron).toHaveAttribute('aria-expanded', 'false')
    await expect(childBlock).toBeHidden()

    // Press Ctrl+Period again → expand. aria-expanded back to true; child shows.
    await page.keyboard.press('Control+Period')
    await expect(chevron).toHaveAttribute('aria-expanded', 'true')
    await expect(childBlock).toBeVisible()
  })

  // #922 f7 — keyboard zoom-in / zoom-out (#217 zoom-in, #774 zoom-out
  // Escape tie-break). Mirrors the context-menu zoom covered by
  // breadcrumb-navigation.spec.ts, but drives it entirely from the keyboard:
  // Alt+. (`zoomIn`) zooms into the focused parent, Escape (`zoomOut`) returns
  // to the page root. Both are gated by `storeOwnsBlock(pageStore,
  // focusedBlockId)`; Alt+. also calls `setFocused(null)` after flushing, so
  // after the zoom no block is focused and Escape is free to zoom out (the
  // #774 tie-break only matters with multiple mounted trees — a single page
  // editor here is unambiguous).
  test('Alt+. zooms into the focused parent and Escape zooms back out', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Capture the root sibling ids so we can assert non-subtree blocks vanish
    // while zoomed. sortable-block wrappers are stable across focus changes.
    const rootBlocks = page.locator('[data-testid="sortable-block"]')
    const rootIds = await rootBlocks.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-block-id') ?? ''),
    )
    expect(rootIds).toHaveLength(5)
    const [gs1Id, , gs3Id, gs4Id] = rootIds

    // Indent GS_4 (index 3) under GS_3 (index 2) so GS_3 is a zoomable parent.
    await focusBlock(page, 3)
    await page.keyboard.press('Control+Shift+ArrowRight')

    // Confirm GS_3 gained a child (chevron appears).
    const parentBlock = rootBlocks.nth(2)
    await expect(parentBlock.locator('[data-testid="collapse-toggle"]')).toBeVisible()

    // Focus the PARENT (GS_3) — Alt+. zooms into the focused, owned block.
    // Escape first to drain GS_4's blur path before re-focusing GS_3.
    await page.keyboard.press('Escape')
    await focusBlock(page, 2)

    // Alt+Period → zoom into GS_3.
    await page.keyboard.press('Alt+Period')

    // The BlockZoomBar breadcrumb trail renders, with GS_3 as the active crumb.
    const breadcrumbNav = page.getByRole('navigation', { name: /zoom breadcrumbs/i })
    await expect(breadcrumbNav).toBeVisible()
    const activeCrumb = breadcrumbNav.locator('[aria-current="page"]')
    await expect(activeCrumb).toBeVisible()
    await expect(activeCrumb).toHaveAttribute('data-zoom-crumb', gs3Id ?? '')

    // Only GS_3's subtree is shown: the child (GS_4) is still rendered, but the
    // other root siblings (GS_1, GS_2, GS_5) are filtered out of the zoomed view.
    await expect(
      page.locator(`[data-testid="sortable-block"][data-block-id="${gs4Id}"]`),
    ).toBeVisible()
    await expect(
      page.locator(`[data-testid="sortable-block"][data-block-id="${gs1Id}"]`),
    ).toHaveCount(0)

    // Zoom-in already called setFocused(null) (it flushes + clears focus before
    // navigating), so no editor holds focus here. Defensively blur any stray
    // active element to document.body, then Escape → zoom out to the page root
    // (the #774 tie-break path). The breadcrumb trail disappears and all root
    // siblings render again.
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    })
    await page.keyboard.press('Escape')

    await expect(breadcrumbNav).toBeHidden()
    await expect(
      page.locator(`[data-testid="sortable-block"][data-block-id="${gs1Id}"]`),
    ).toBeVisible()
  })
})

// ===========================================================================
// 5. Global shortcuts
// ===========================================================================

test.describe('Global shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+F opens in-page find toolbar', async ({ page }) => {
    // Rebind — Ctrl+F now opens the in-page find toolbar (browser
    // convention). Find-in-files moved to Ctrl+Shift+F.
    await page.keyboard.down('Control')
    await page.keyboard.press('f')
    await page.keyboard.up('Control')

    // In-page find toolbar is visible at the top of the editor.
    await expect(page.getByRole('toolbar', { name: /find/i })).toBeVisible()
  })

  test('Ctrl+Shift+F opens search view', async ({ page }) => {
    // Rebind — find-in-files moved from Ctrl+F to Ctrl+Shift+F.
    await page.keyboard.down('Control')
    await page.keyboard.down('Shift')
    await page.keyboard.press('f')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Control')

    await expect(page.getByTestId('header-label')).toHaveText('Search')
  })

  test('Ctrl+K opens search palette when focus is outside the editor', async ({ page }) => {
    // Cmd/Ctrl+K opens the quick-nav palette. Context-aware:
    // only fires when focus is OUTSIDE any TipTap/ProseMirror surface.
    // Palette refactored to cmdk; the input testid moved
    // from `search-palette-input` to `command-palette-input` along
    // with the SearchPalette → CommandPalette rename.
    // Click on the sidebar to take focus out of the editor.
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Pages', exact: true })
      .click()
    await expect(page.getByTestId('header-label')).toHaveText('Pages')

    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')

    await expect(page.getByTestId('command-palette-input')).toBeVisible()
  })

  test('Ctrl+N creates new page', async ({ page }) => {
    // Press Ctrl+N to create a new page
    await page.keyboard.down('Control')
    await page.keyboard.press('n')
    await page.keyboard.up('Control')

    // Verify navigation to the new page (page editor with "Untitled" title)
    await expect(page.locator('[aria-label="Page title"]')).toBeVisible()
    await expect(page.locator('[aria-label="Page title"]')).toContainText('Untitled')
  })

  test('Alt+Left navigates journal back', async ({ page }) => {
    // We start on the journal view, get the current date display
    const initialDate = await page.locator('[data-testid="date-display"]').textContent()

    // Press Alt+Left to go to previous day
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')

    // Wait for the date display to change
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(initialDate)
  })

  test('Alt+Right navigates journal forward', async ({ page }) => {
    // Capture today's date before navigating
    const todayDate = await page.locator('[data-testid="date-display"]').textContent()

    // First go back a day so we can go forward
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')

    // Wait for the date to change from today
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(todayDate)

    const backDate = await page.locator('[data-testid="date-display"]').textContent()

    // Blur any editor that stole focus from the auto-created block for the
    // new (empty) journal page. The product's `isTypingInField()` guard in
    // JOURNAL_SHORTCUTS correctly skips navigation when a contenteditable
    // owns focus so Alt+← / Alt+→ keep their native word-nav semantics
    // inside the editor. Click the header (non-focusable) to move focus
    // back to <body> before the second shortcut fires.
    await page.locator('header').first().click()

    // Press Alt+Right to go forward
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.up('Alt')

    // Wait for the date display to change from the back date
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(backDate)
  })

  test('Alt+T goes to today', async ({ page }) => {
    // Get today's date display
    const todayDate = await page.locator('[data-testid="date-display"]').textContent()

    // Navigate back a day first
    await page.keyboard.down('Alt')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.up('Alt')

    // Wait for the date to change from today
    await expect(page.locator('[data-testid="date-display"]')).not.toHaveText(todayDate)

    // Blur any editor that stole focus from the auto-created block for the
    // new (empty) journal page — see the matching comment in the Alt+Right
    // test above. Without this, `isTypingInField()` short-circuits Alt+T
    // so it keeps its native editor semantics.
    await page.locator('header').first().click()

    // Press Alt+T to go to today
    await page.keyboard.down('Alt')
    await page.keyboard.press('t')
    await page.keyboard.up('Alt')

    // Wait for the date to return to today
    await expect(page.locator('[data-testid="date-display"]')).toHaveText(todayDate)
  })

  test('? opens keyboard shortcuts panel', async ({ page }) => {
    // `KeyboardShortcuts` is React.lazy-loaded (App.tsx), and its global `?`
    // keydown listener is only attached once the chunk resolves and the
    // component mounts. Under parallel-worker load the chunk can still be
    // in flight when the keystroke is dispatched, so we retry the press
    // until the listener is live and the sheet opens.
    await expect(async () => {
      // Click on the header to ensure no input/textarea/contenteditable is focused
      await page.locator('header').first().click()

      // Type ? using keyboard.type which dispatches keydown with key='?'
      await page.keyboard.type('?')

      // Verify the shortcuts sheet is visible (it has a data-testid="shortcuts-table")
      await expect(page.locator('[data-testid="shortcuts-table"]')).toBeVisible({ timeout: 1000 })
    }).toPass({ timeout: 10000 })

    // Also verify the sheet title (SheetTitle renders `shortcuts.title`,
    // i.e. "Quick Reference" — not "Keyboard Shortcuts", which only appears
    // in the Settings view).
    await expect(page.getByRole('heading', { name: 'Quick Reference' })).toBeVisible()
  })
})

// ===========================================================================
// 6. Link shortcuts
// ===========================================================================

test.describe('Link shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Ctrl+K opens link popover when focus is inside the editor', async ({ page }) => {
    // Context-aware Cmd+K — focus is inside the editor (TipTap), so
    // useAppKeyboardShortcuts yields to TipTap's own keymap instead of
    // Opening the palette. +.
    await openPage(page, 'Getting Started')
    await focusBlock(page)

    await page.keyboard.down('Control')
    await page.keyboard.press('k')
    await page.keyboard.up('Control')

    await expect(page.getByTestId('link-edit-popover')).toBeVisible()
    await expect(page.getByPlaceholder('https://...')).toBeVisible()
  })
})
