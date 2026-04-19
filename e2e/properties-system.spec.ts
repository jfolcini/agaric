import { expect, openPage, test, waitForBoot } from './helpers'

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

    // Click "Properties..." in the context menu
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()

    // The property drawer (Sheet) should open with title "Block Properties"
    await expect(page.getByText('Block Properties')).toBeVisible()

    // Verify both properties are listed: context and project
    await expect(page.getByText('context', { exact: true })).toBeVisible()
    await expect(page.getByText('project', { exact: true })).toBeVisible()
  })

  test('property drawer shows editable input with current values', async ({ page }) => {
    await openPage(page, 'Meetings')

    // Open the property drawer for the first meeting block
    const firstBlock = page.locator('[data-testid="sortable-block"]').first()
    await firstBlock.click({ button: 'right' })
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()

    await expect(page.getByText('Block Properties')).toBeVisible()

    // The drawer shows Input elements with defaultValues from properties
    // context = "@office", project = "alpha"
    const inputs = page.locator('[role="dialog"] input.flex-1')
    await expect(inputs.first()).toBeVisible()

    // Verify input values match seed data
    await expect(inputs.first()).toHaveValue('@office')
    await expect(inputs.nth(1)).toHaveValue('alpha')
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
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()

    await expect(page.getByText('Block Properties')).toBeVisible()

    // Should show "No properties set" initially for GS_1
    await expect(page.getByText('No properties set')).toBeVisible()

    // Click the "Add property" button to open the popover
    await page.getByRole('button', { name: 'Add property' }).click()

    // Available property definitions should appear (context and project)
    await expect(page.getByText('context')).toBeVisible()
    await expect(page.getByText('project')).toBeVisible()

    // Select "context" definition
    await page.getByText('context').click()

    // An input field should appear for the value
    const valueInput = page.locator('[role="dialog"] input[placeholder="context"]')
    await expect(valueInput).toBeVisible()
    await valueInput.fill('@home')

    // Click Save to apply
    await page.getByRole('button', { name: 'Save', exact: true }).click()

    // The "No properties set" message should disappear
    await expect(page.getByText('No properties set')).not.toBeVisible()

    // The new property should now appear in the drawer
    await expect(page.getByText('context', { exact: true })).toBeVisible()
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
    const menu = page.locator('[role="menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[role="menuitem"]', { hasText: 'Properties' }).click()
    await expect(page.getByText('Block Properties')).toBeVisible()

    // Both properties should be visible
    await expect(page.getByText('context', { exact: true })).toBeVisible()
    await expect(page.getByText('project', { exact: true })).toBeVisible()

    // Click the delete (X) button for the first property
    const deleteButtons = page.locator('[role="dialog"] button[aria-label="Delete property"]')
    await expect(deleteButtons.first()).toBeVisible()
    await deleteButtons.first().click()

    // The "context" property should disappear from the drawer
    // (project should remain)
    await expect(
      page.locator('[role="dialog"]').getByText('context', { exact: true }),
    ).not.toBeVisible()
    await expect(
      page.locator('[role="dialog"]').getByText('project', { exact: true }),
    ).toBeVisible()
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
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Properties', exact: true })
      .click()

    // Should show the "Property Definitions" heading
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // Seed definitions: context (text) and project (select)
    await expect(page.getByText('context')).toBeVisible()
    await expect(page.getByText('project')).toBeVisible()

    // Type badges should be visible
    await expect(page.getByText('text')).toBeVisible()
    await expect(page.getByText('select')).toBeVisible()
  })

  test('search filters property definitions by key', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Properties', exact: true })
      .click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // Type into the search input
    const searchInput = page.getByLabel('Search properties...')
    await searchInput.fill('proj')

    // Only "project" should remain visible, "context" should be filtered out
    await expect(page.getByText('project')).toBeVisible()

    // The definitions list should only contain the project definition
    const defItems = page.locator('ul > li')
    await expect(defItems).toHaveCount(1)
  })

  test('creating a new property definition adds it to the list', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Properties', exact: true })
      .click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // Fill in the create form
    const keyInput = page.getByLabel('Property key')
    await keyInput.fill('status')

    // Select "text" type (default)
    await page.getByRole('button', { name: 'Create' }).click()

    // New definition should appear in the list
    await expect(page.getByText('status')).toBeVisible()
  })

  test('deleting a property definition with confirmation removes it', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Properties', exact: true })
      .click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // Hover over the "context" row and click the delete button
    const contextRow = page.locator('ul > li', { hasText: 'context' })
    await expect(contextRow).toBeVisible()
    await contextRow.hover()

    const deleteBtn = contextRow.getByRole('button', { name: 'Delete property context' })
    await expect(deleteBtn).toBeVisible()
    await deleteBtn.click()

    // Confirmation dialog should appear
    await expect(page.getByText('Delete this property definition?')).toBeVisible()

    // Confirm deletion
    await page.getByRole('button', { name: 'Delete', exact: true }).click()

    // "context" should no longer be in the list
    await expect(page.locator('ul > li', { hasText: 'context' })).not.toBeVisible()

    // "project" should still be there
    await expect(page.locator('ul > li', { hasText: 'project' })).toBeVisible()
  })

  test('select-type property shows Edit options button', async ({ page }) => {
    await page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Properties', exact: true })
      .click()
    await expect(page.getByText('Property Definitions')).toBeVisible()

    // The "project" definition (type: select) should have an "Edit options" button
    const projectRow = page.locator('ul > li', { hasText: 'project' })
    await expect(projectRow).toBeVisible()
    await expect(projectRow.getByRole('button', { name: 'Edit options' })).toBeVisible()
  })
})
