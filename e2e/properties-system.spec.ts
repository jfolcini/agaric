import {
  activeAlertDialog,
  activeMenu,
  activePopover,
  activeSheet,
  expect,
  openPage,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E tests for the properties system.
 *
 * Covers:
 *  1. Property chips visible on blocks that have properties
 *  2. Property drawer shows correct values for a block
 *  3. Setting a new property on a block via the drawer
 *  4. Deleting a property from a block via the drawer
 *  5. Property definitions view (browse/create/delete definitions)
 *
 * Seed data (tauri-mock.ts):
 *   PAGE_MEETINGS ("Meetings") — 2 child blocks:
 *     BLOCK_MTG_1: "Weekly standup notes"  — context: @office, project: alpha
 *     BLOCK_MTG_2: "Design review feedback" — context: @remote, project: beta
 *   Property definitions:
 *     context (text), project (select: alpha, beta, gamma)
 */

// ===========================================================================
// 1. Property chips visible on blocks
// ===========================================================================

test.describe('Property chips on blocks', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Meetings page blocks show property chips', async ({ page }) => {
    await openPage(page, 'Meetings')

    // Both meeting blocks should be visible
    const blocks = page.locator('[data-testid="sortable-block"]')
    await expect(blocks).toHaveCount(2, { timeout: 5000 })

    // First block (Weekly standup notes) should have property chips
    const firstBlock = blocks.first()
    await expect(firstBlock).toContainText('Weekly standup notes')
    const firstChips = firstBlock.locator('[data-testid="property-chip"]')
    await expect(firstChips.first()).toBeVisible()

    // Verify context and project property chips are shown
    // PropertyChip renders "key:" label + value span
    await expect(
      firstBlock.locator('[data-testid="property-chip"]', { hasText: 'context' }),
    ).toBeVisible()
    await expect(
      firstBlock.locator('[data-testid="property-chip"]', { hasText: '@office' }),
    ).toBeVisible()
    await expect(
      firstBlock.locator('[data-testid="property-chip"]', { hasText: 'project' }),
    ).toBeVisible()
    await expect(
      firstBlock.locator('[data-testid="property-chip"]', { hasText: 'alpha' }),
    ).toBeVisible()
  })

  test('second meeting block shows its own property values', async ({ page }) => {
    await openPage(page, 'Meetings')

    const secondBlock = page.locator('[data-testid="sortable-block"]').nth(1)
    await expect(secondBlock).toContainText('Design review feedback')

    // Should show context: @remote and project: beta
    await expect(
      secondBlock.locator('[data-testid="property-chip"]', { hasText: '@remote' }),
    ).toBeVisible()
    await expect(
      secondBlock.locator('[data-testid="property-chip"]', { hasText: 'beta' }),
    ).toBeVisible()
  })
})

// ===========================================================================
// 2. Property drawer shows block properties
// ===========================================================================

test.describe('Property drawer', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('opening property drawer via context menu shows correct properties', async ({ page }) => {
    await openPage(page, 'Meetings')

    // Right-click the first block to open context menu
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await expect(firstBlock).toBeVisible()
    await firstBlock.click({ button: 'right' })

    // TEST-1b: scope to the active `role="menu"` so stale context-menu DOM
    // from a previous test (which lives in `document.body` after it closes
    // and may briefly coexist with the fresh menu) can't match first.
    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()

    // TEST-1b: the property drawer is a Radix Sheet; scope to the active
    // sheet-content so stale Sheet portals from previous tests can't match.
    const sheet = activeSheet(page)
    await expect(sheet.getByText('Block Properties')).toBeVisible()

    // Verify both properties are listed: context and project
    await expect(sheet.getByText('context', { exact: true })).toBeVisible()
    await expect(sheet.getByText('project', { exact: true })).toBeVisible()
  })

  test('property drawer shows editable input with current values', async ({ page }) => {
    await openPage(page, 'Meetings')

    // Open the property drawer for the first meeting block
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.click({ button: 'right' })
    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()

    const sheet = activeSheet(page)
    await expect(sheet.getByText('Block Properties')).toBeVisible()

    // The drawer shows Input elements with defaultValues from properties
    // context = "@office", project = "alpha".
    // Use per-key data-testids (set in BlockPropertyDrawer) for stable
    // selection — the raw class name was brittle and drifted when the
    // wrapping div (not the input itself) owned `flex-1`.
    const contextInput = sheet.locator('input[data-testid="property-value-input-context"]')
    const projectInput = sheet.locator('input[data-testid="property-value-input-project"]')
    await expect(contextInput).toBeVisible()
    await expect(projectInput).toBeVisible()

    // Verify input values match seed data
    await expect(contextInput).toHaveValue('@office')
    await expect(projectInput).toHaveValue('alpha')
  })
})

// ===========================================================================
// 3. Set a new property on a block
// ===========================================================================

test.describe('Set property via drawer', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('adding a property from definitions appears in the drawer', async ({ page }) => {
    await openPage(page, 'Getting Started')

    // Right-click the first block and open properties
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.click({ button: 'right' })
    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()

    const sheet = activeSheet(page)
    await expect(sheet.getByText('Block Properties')).toBeVisible()

    // Should show "No properties set" initially for GS_1
    await expect(sheet.getByText('No properties set')).toBeVisible()

    // Click the "Add property" button to open the popover (scoped to the Sheet)
    await sheet.getByRole('button', { name: 'Add property' }).click()

    // TEST-1b: the definition picker is a Radix Popover separate from the
    // Sheet; scope to the active popover-content so stale popover DOM
    // cannot match the same label text.
    const popover = activePopover(page)
    await expect(popover.getByText('context')).toBeVisible()
    await expect(popover.getByText('project')).toBeVisible()

    // Select "context" definition
    await popover.getByText('context').click()

    // An input field should appear for the newly-added property value.
    // Target the data-testid (set in BlockPropertyDrawer) rather than a
    // placeholder that was never rendered for text-type properties.
    const valueInput = sheet.locator('input[data-testid="property-value-input-context"]')
    await expect(valueInput).toBeVisible()
    await valueInput.fill('@home')

    // Commit the value. The drawer has no dedicated Save button — pressing
    // Enter triggers the input's onKeyDown→blur handler in PropertyRow,
    // which calls onSave and persists via setProperty.
    await valueInput.press('Enter')

    // The "No properties set" message should disappear
    await expect(sheet.getByText('No properties set')).not.toBeVisible()

    // The new property should now appear in the drawer
    await expect(sheet.getByText('context', { exact: true })).toBeVisible()
  })
})

// ===========================================================================
// 4. Delete a property from a block
// ===========================================================================

test.describe('Delete property via drawer', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('deleting a property removes it from the drawer', async ({ page }) => {
    await openPage(page, 'Meetings')

    // Open the property drawer for the first meeting block (has context + project)
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.click({ button: 'right' })
    const menu = activeMenu(page)
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()
    const sheet = activeSheet(page)
    await expect(sheet.getByText('Block Properties')).toBeVisible()

    // Both properties should be visible
    await expect(sheet.getByText('context', { exact: true })).toBeVisible()
    await expect(sheet.getByText('project', { exact: true })).toBeVisible()

    // Click the delete (X) button for the first property
    const deleteButtons = sheet.locator('button[aria-label="Delete property"]')
    await expect(deleteButtons.first()).toBeVisible()
    await deleteButtons.first().click()

    // The "context" property should disappear from the drawer
    // (project should remain)
    await expect(sheet.getByText('context', { exact: true })).not.toBeVisible()
    await expect(sheet.getByText('project', { exact: true })).toBeVisible()
  })
})

// ===========================================================================
// 5. Property definitions view (browse, create, delete)
// ===========================================================================

test.describe('Property definitions view', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('Properties sidebar shows seed property definitions', async ({ page }) => {
    // Navigate to Properties view via sidebar
    // Properties live under Settings → Properties tab (the old sidebar
    // Properties item was merged into Settings).
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await page.getByRole('tab', { name: 'Properties' }).click()

    // Should show the "Property Definitions" heading
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // Seed definitions: context (text) and project (select) — scope to
    // the settings panel so the sidebar's own <ul><li> menu doesn't match.
    const settingsPanel = page.locator('[data-testid="settings-panel-properties"]')
    await expect(settingsPanel.locator('li', { hasText: 'context' })).toBeVisible()
    await expect(settingsPanel.locator('li', { hasText: 'project' })).toBeVisible()
    await expect(settingsPanel.locator('li', { hasText: 'context' })).toContainText('text')
    await expect(settingsPanel.locator('li', { hasText: 'project' })).toContainText('select')
  })

  test('search filters property definitions by key', async ({ page }) => {
    // Properties live under Settings → Properties tab (the old sidebar
    // Properties item was merged into Settings).
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await page.getByRole('tab', { name: 'Properties' }).click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // Type into the search input
    const settingsPanel = page.locator('[data-testid="settings-panel-properties"]')
    const searchInput = settingsPanel.getByLabel('Search properties...')
    await searchInput.fill('proj')

    // Only "project" should remain visible, "context" should be filtered out
    await expect(settingsPanel.getByText('project')).toBeVisible()

    // The definitions list should only contain the project definition
    const defItems = settingsPanel.locator('ul > li')
    await expect(defItems).toHaveCount(1)
  })

  test('creating a new property definition adds it to the list', async ({ page }) => {
    // Properties live under Settings → Properties tab (the old sidebar
    // Properties item was merged into Settings).
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await page.getByRole('tab', { name: 'Properties' }).click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // Fill in the create form (scoped to the settings panel so the sidebar's
    // "New Page" button / other UI doesn't confuse the locator).
    const settingsPanel = page.locator('[data-testid="settings-panel-properties"]')
    const keyInput = settingsPanel.getByLabel('Property key')
    await keyInput.fill('status')

    // Select "text" type (default)
    await settingsPanel.getByRole('button', { name: 'Create' }).click()

    // New definition should appear in the list
    await expect(settingsPanel.locator('ul li', { hasText: 'status' })).toBeVisible()
  })

  test('deleting a property definition with confirmation removes it', async ({ page }) => {
    // Properties live under Settings → Properties tab (the old sidebar
    // Properties item was merged into Settings).
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await page.getByRole('tab', { name: 'Properties' }).click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    const settingsPanel = page.locator('[data-testid="settings-panel-properties"]')

    // Hover over the "context" row and click the delete button
    const contextRow = settingsPanel.locator('ul > li', { hasText: 'context' })
    await expect(contextRow).toBeVisible()
    await contextRow.hover()

    const deleteBtn = contextRow.getByRole('button', { name: 'Delete property context' })
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // TEST-1b: the confirmation is a Radix AlertDialog; scope to the
    // active alert-dialog-content so a stale AlertDialog from a previous
    // test can't match.
    const confirm = activeAlertDialog(page)
    await expect(confirm.getByText('Delete this property definition?')).toBeVisible()

    // Confirm deletion
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click()

    // "context" should no longer be in the list
    await expect(settingsPanel.locator('ul > li', { hasText: 'context' })).not.toBeVisible()

    // "project" should still be there
    await expect(page.locator('ul > li', { hasText: 'project' })).toBeVisible()
  })

  test('select-type property shows Edit options button', async ({ page }) => {
    // Properties live under Settings → Properties tab (the old sidebar
    // Properties item was merged into Settings).
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await page.getByRole('tab', { name: 'Properties' }).click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // The "project" definition (type: select) should have an "Edit options" button
    const settingsPanel = page.locator('[data-testid="settings-panel-properties"]')
    const projectRow = settingsPanel.locator('ul > li', { hasText: 'project' })
    await expect(projectRow).toBeVisible()
    await expect(projectRow.getByRole('button', { name: 'Edit options' })).toBeVisible()
  })
})
