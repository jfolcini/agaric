import type { Page } from '@playwright/test'

import {
  activePopover,
  activeRoleDialog,
  expect,
  focusBlock,
  navigateToView,
  openPage,
  test,
  typeSlashCommand,
  waitForBoot,
} from './helpers'

// Template-lifecycle tests chain create/remove/apply template
// sequences inside a describe — serial run prevents cross-test mock-state
// interleaving under fullyParallel.
test.describe.configure({ mode: 'serial' })

/**
 * E2E tests for the templates system.
 *
 * Covers:
 *  1. Save a page as template (via PageHeader kebab menu)
 *  2. Remove template status from a page
 *  3. View template list via /template slash command
 *  4. Apply template to a page (inserts template children)
 *  5. Template variable expansion (<% today %> becomes current date)
 *  6. Set/remove journal template via kebab menu
 *  7. Pick the journal template from the journal; a new day copies it, nesting included
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_TMPL_MEETING ("Meeting Notes Template") — 3 child blocks:
 *     BLOCK_TMPL_M1: "## Attendees"
 *     BLOCK_TMPL_M2: "## Notes — <% today %>"
 *     BLOCK_TMPL_M3: "## Action items for <% page title %>"
 *   Property: template = 'true' (pre-seeded)
 *
 *   PAGE_GETTING_STARTED ("Getting Started") — used as target for template insertion
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Call the mock backend directly, to seed state and read it back. */
function ipc<T>(page: Page, cmd: string, args: Record<string, unknown>): Promise<T> {
  return page.evaluate(
    ({ c, a }) => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__.invoke
      return invoke(c, a)
    },
    { c: cmd, a: args },
  ) as Promise<T>
}

/** Open the kebab (page actions) menu on the current page. */
async function openKebabMenu(page: import('@playwright/test').Page) {
  const kebab = page.getByRole('button', { name: 'Page actions' })
  await expect(kebab).toBeVisible()
  await kebab.click()
}

// The canonical race-free `typeSlashCommand` helper lives in `./helpers` and
// is imported above. See the JSDoc there for the split-keystroke rationale
// (it avoids the slash-extension's 200ms single-match auto-execute timer).

/**
 * Open the template picker via the /template slash command and return its
 * dialog locator.
 *
 * Types `/template`, then presses Enter to select the single match (#924
 * removed the un-cued 200ms auto-execute, so selection is now always explicit).
 * Selecting the TEMPLATE command dispatches `ctx.openTemplatePicker()`, which
 * opens the dialog — we then wait for it.
 */
async function openTemplatePicker(page: import('@playwright/test').Page) {
  await typeSlashCommand(page, 'template')
  // #924 — slash commands no longer auto-execute; select the single match
  // explicitly (the un-cued 200ms auto-fire was removed).
  await page.keyboard.press('Enter')
  const dialog = activeRoleDialog(page)
  await expect(dialog).toBeVisible({ timeout: 5000 })
  return dialog
}

// ===========================================================================
// 1. Save a page as template
// ===========================================================================

test.describe('Save page as template', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('kebab menu shows "Save as template" for non-template page', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await openKebabMenu(page)

    // The kebab menu is a Radix Popover; scope to the active
    // popover-content so a stale portal from a previous test can't match.
    await expect(activePopover(page).getByText('Save as template')).toBeVisible()
  })

  test('clicking "Save as template" shows success toast', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await openKebabMenu(page)

    await activePopover(page).getByText('Save as template').click()

    // Success toast is rendered by sonner (outside Radix portals) — leave
    // it at page scope.
    await expect(page.getByText('Saved as template')).toBeVisible()
  })

  test('after saving as template, kebab shows "Remove template status"', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Save as template
    await openKebabMenu(page)
    await activePopover(page).getByText('Save as template').click()
    await expect(page.getByText('Saved as template')).toBeVisible()

    // Re-open kebab — should now show "Remove template status"
    await openKebabMenu(page)
    await expect(activePopover(page).getByText('Remove template status')).toBeVisible()
  })
})

// ===========================================================================
// 2. Remove template status
// ===========================================================================

test.describe('Remove template status', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('pre-seeded template page shows "Remove template status" in kebab', async ({ page }) => {
    await openPage(page, 'Meeting Notes Template')
    await openKebabMenu(page)

    await expect(activePopover(page).getByText('Remove template status')).toBeVisible()
  })

  test('removing template status shows success toast', async ({ page }) => {
    await openPage(page, 'Meeting Notes Template')
    await openKebabMenu(page)

    await activePopover(page).getByText('Remove template status').click()

    await expect(page.getByText('Template status removed')).toBeVisible()
  })

  test('after removing, kebab shows "Save as template" again', async ({ page }) => {
    await openPage(page, 'Meeting Notes Template')

    // Remove template status
    await openKebabMenu(page)
    await activePopover(page).getByText('Remove template status').click()
    await expect(page.getByText('Template status removed')).toBeVisible()

    // Re-open kebab — should now show "Save as template"
    await openKebabMenu(page)
    await expect(activePopover(page).getByText('Save as template')).toBeVisible()
  })
})

// ===========================================================================
// 3. Template list via /template slash command
// ===========================================================================

test.describe('Template picker via slash command', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('/template slash command shows template picker dialog', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const dialog = await openTemplatePicker(page)

    // Should show the seeded template
    await expect(dialog.getByText('Meeting Notes Template')).toBeVisible()
  })

  test('template picker shows preview text', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const dialog = await openTemplatePicker(page)

    // Should show "Select a template" heading
    await expect(dialog.getByText('Select a template')).toBeVisible()

    // Preview text from first child block should be visible
    await expect(dialog.getByText('## Attendees')).toBeVisible()
  })

  test('Escape closes the template picker', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const dialog = await openTemplatePicker(page)

    await page.keyboard.press('Escape')

    await expect(dialog).not.toBeVisible()
  })
})

// ===========================================================================
// 4. Apply template to a page
// ===========================================================================

test.describe('Apply template', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('selecting template inserts blocks and shows success toast', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const dialog = await openTemplatePicker(page)

    // Pick the Meeting Notes Template from the picker
    await dialog.getByText('Meeting Notes Template').click()

    // Success toast
    await expect(page.getByText('Template inserted')).toBeVisible({ timeout: 5000 })
  })

  test('applied template blocks appear on the page', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const dialog = await openTemplatePicker(page)
    await dialog.getByText('Meeting Notes Template').click()

    await expect(page.getByText('Template inserted')).toBeVisible({ timeout: 5000 })

    // Template blocks should be rendered on the page
    // "## Attendees" should appear (first template child)
    await expect(
      page.locator('[data-testid="sortable-block"]', { hasText: 'Attendees' }),
    ).toBeVisible({
      timeout: 5000,
    })
  })
})

// ===========================================================================
// 5. Template variable expansion
// ===========================================================================

test.describe('Template variable expansion', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('<% today %> is expanded to current date', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const dialog = await openTemplatePicker(page)
    await dialog.getByText('Meeting Notes Template').click()
    await expect(page.getByText('Template inserted')).toBeVisible({ timeout: 5000 })

    // The template child "## Notes — <% today %>" should become "## Notes — YYYY-MM-DD"
    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const todayStr = `${yyyy}-${mm}-${dd}`

    await expect(
      page.locator('[data-testid="sortable-block"]', { hasText: `Notes — ${todayStr}` }),
    ).toBeVisible({ timeout: 5000 })
  })

  test('<% page title %> is expanded to target page title', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await focusBlock(page)
    const dialog = await openTemplatePicker(page)
    await dialog.getByText('Meeting Notes Template').click()
    await expect(page.getByText('Template inserted')).toBeVisible({ timeout: 5000 })

    // The template child "## Action items for <% page title %>" should become
    // "## Action items for Getting Started"
    await expect(
      page.locator('[data-testid="sortable-block"]', {
        hasText: 'Action items for Getting Started',
      }),
    ).toBeVisible({ timeout: 5000 })
  })
})

// ===========================================================================
// 6. Journal template toggle
// ===========================================================================

test.describe('Journal template toggle', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('kebab menu shows "Set as journal template" option', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await openKebabMenu(page)

    await expect(activePopover(page).getByText('Set as journal template')).toBeVisible()
  })

  test('setting journal template shows success toast', async ({ page }) => {
    await openPage(page, 'Getting Started')
    await openKebabMenu(page)

    await activePopover(page).getByText('Set as journal template').click()

    // The toast's body text matches the menu-item text verbatim ("Set as
    // journal template"). Wait for the popover to fully unmount before
    // asserting on the toast so both aren't matched simultaneously.
    await expect(activePopover(page)).not.toBeVisible()
    await expect(page.getByText('Set as journal template', { exact: false })).toBeVisible()
  })

  test('after setting, kebab shows "Remove journal template"', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Set as journal template
    await openKebabMenu(page)
    await activePopover(page).getByText('Set as journal template').click()

    // Deterministic wait: the click closes the popover, indicating the
    // command dispatched. The in-memory mock backend applies the state
    // change synchronously after dispatch. Wait on the active popover
    // going invisible — not on a stale `[role="menu"]` (the kebab is a
    // Popover, not a menu).
    await expect(activePopover(page)).not.toBeVisible()

    // Re-open kebab
    await openKebabMenu(page)
    await expect(activePopover(page).getByText('Remove journal template')).toBeVisible()
  })
})

// ===========================================================================
// 7. Journal template from the journal (#5373)
// ===========================================================================

test.describe('Journal template button', () => {
  const SPACE_SCOPE = { kind: 'active', space_id: 'SPACE_PERSONAL' }
  const BLOCK_TMPL_ATTENDEES = '0000000000000000000BLOCK20'
  const NESTED = 'Nested under attendees'

  interface Row {
    id: string
    parent_id: string | null
    content: string | null
  }

  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('a template page picked from the journal seeds a new day with its nested blocks', async ({
    page,
  }) => {
    await ipc(page, 'create_block', {
      blockType: 'content',
      content: NESTED,
      parentId: BLOCK_TMPL_ATTENDEES,
      index: null,
      scope: { kind: 'global' },
      blockId: null,
    })

    await navigateToView(page, 'Journal')
    await page.getByRole('button', { name: 'Configure journal template' }).click()
    await activePopover(page).getByRole('button', { name: 'Meeting Notes Template' }).click()
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Meeting Notes Template')

    await navigateToView(page, 'Journal')
    await page.getByRole('button', { name: 'Next day' }).click()
    await page.getByRole('button', { name: 'Add your first block' }).click()
    await expect(page.locator('[data-testid="sortable-block"]', { hasText: NESTED })).toBeVisible()

    const tomorrow = await page.evaluate(() => {
      const d = new Date()
      d.setDate(d.getDate() + 1)
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      return `${d.getFullYear()}-${mm}-${dd}`
    })
    const dayPage = await ipc<Row | null>(page, 'get_journal_page_by_date', {
      date: tomorrow,
      scope: SPACE_SCOPE,
    })
    expect(dayPage).not.toBeNull()
    const { blocks } = await ipc<{ blocks: Row[] }>(page, 'load_page_subtree', {
      rootBlockId: dayPage?.id,
      scope: SPACE_SCOPE,
    })
    const attendees = blocks.find((b) => b.content === '## Attendees')
    const nested = blocks.find((b) => b.content === NESTED)
    expect(attendees?.parent_id).toBe(dayPage?.id)
    expect(nested?.parent_id).toBe(attendees?.id)
  })
})
