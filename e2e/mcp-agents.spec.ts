import type { Page } from '@playwright/test'

import {
  activeAlertDialog,
  activeDialog,
  axeViolations,
  expect,
  ipc,
  readClipboard,
  test,
} from './helpers'

/**
 * E2E — Settings → Agent access → Agents (#5667): add an agent, copy its
 * config, revoke it, with axe on the empty state, the list and the dialog.
 * Focus returns to "Add agent" after each, which the vitest DOM cannot show
 * (Radix's close-time focus).
 */

/** The axe violations inside `selector`, by rule id. */
function structuralViolations(page: Page, selector: string): Promise<string[]> {
  // Colour contrast follows the design tokens, not this card's structure.
  return axeViolations(page, selector, { rules: { 'color-contrast': { enabled: false } } })
}

test.describe('Agents card @mcp', () => {
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
    expect(await structuralViolations(page, '[data-testid="settings-panel-agent"]')).toEqual([])

    await page.getByRole('button', { name: 'Add agent' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('Name').fill('Planner')
    await dialog.getByRole('radio', { name: 'Read and write' }).click()
    expect(await structuralViolations(page, '[data-slot="dialog-content"]')).toEqual([])
    await dialog.getByLabel('Name').press('Enter')

    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('Planner')
    await expect(rows).toContainText('Read and write')
    await expect(rows).toContainText('All spaces · Never used')
    await expect(page.getByRole('button', { name: 'Add agent' })).toBeFocused()
    expect(await structuralViolations(page, '[data-testid="settings-panel-agent"]')).toEqual([])

    await page.getByRole('button', { name: 'Revoke Planner' }).click()
    await activeAlertDialog(page).getByRole('button', { name: 'Revoke' }).click()

    await expect(rows).toHaveCount(0)
    await expect(page.getByText('No agents yet')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add agent' })).toBeFocused()
  })

  test("copies the agent's config with its token and the socket", async ({ page }) => {
    await page.getByRole('button', { name: 'Add agent' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('Name').fill('Planner')
    await dialog.getByLabel('Name').press('Enter')
    await expect(page.getByTestId('mcp-agent-row')).toContainText('Planner')
    const [agent] = await ipc<Array<{ id: string; token: string }>>(page, 'list_mcp_agents', {})
    const token = agent?.token ?? ''
    // The tail of the id the config's server name ends with, lowercased.
    const tail = (agent?.id ?? '').slice(-6).toLowerCase()
    // Where the bridge binary and the socket are: the mock's fixed paths, or the bridge vault's.
    const status = await ipc<{
      bridge_command: string
      bridge_args: string[]
      socket_path: string
    }>(page, 'get_mcp_status', {})
    expect(status.bridge_args).toEqual([])
    expect(token).toMatch(/^agt_[0-9a-f]{32}$/)

    await page.getByRole('button', { name: 'Copy Claude Code command for Planner' }).click()
    await expect(page.getByText('Claude Code command copied')).toBeVisible()
    expect(await readClipboard(page)).toBe(
      `claude mcp add -s user agaric-planner-${tail} -- "${status.bridge_command}" --socket "${status.socket_path}" --token ${token}`,
    )

    await page.getByRole('button', { name: 'Copy Claude Desktop config for Planner' }).click()
    await expect(page.getByText('Claude Desktop config copied')).toBeVisible()
    const config = JSON.parse(await readClipboard(page)) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(Object.values(config.mcpServers)).toEqual([
      {
        command: status.bridge_command,
        args: ['--socket', status.socket_path, '--token', token],
      },
    ])
  })
})
