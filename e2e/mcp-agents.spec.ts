import { activeAlertDialog, activeDialog, expect, test } from './helpers'

/**
 * E2E — Settings → Agent access → Agents (#5667): add an agent, see it
 * listed, revoke it. Focus returns to "Add agent" after each, which the
 * vitest DOM cannot show (Radix's close-time focus).
 */

test.describe('Agents card', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Agent access' }).click()
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()
  })

  test('adds an agent, lists it, and revokes it', async ({ page }) => {
    const rows = page.getByTestId('mcp-agent-row')
    await expect(page.getByText('No agents yet')).toBeVisible()
    await expect(rows).toHaveCount(0)

    await page.getByRole('button', { name: 'Add agent' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('Name').fill('Planner')
    await dialog.getByRole('radio', { name: 'Read and write' }).click()
    await dialog.getByLabel('Name').press('Enter')

    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('Planner')
    await expect(rows).toContainText('Read and write')
    await expect(rows).toContainText('All spaces · Never used')
    await expect(page.getByRole('button', { name: 'Add agent' })).toBeFocused()

    await page.getByRole('button', { name: 'Revoke Planner' }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Revoke' }).click()

    await expect(rows).toHaveCount(0)
    await expect(page.getByText('No agents yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add agent' })).toBeFocused()
  })
})
