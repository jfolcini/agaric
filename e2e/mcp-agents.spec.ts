import { createRequire } from 'node:module'

import type { Page } from '@playwright/test'

import { activeAlertDialog, activeDialog, expect, readClipboard, test } from './helpers'

const axePath = createRequire(import.meta.url).resolve('axe-core')

/**
 * E2E — Settings → Agent access → Agents (#5667): add an agent, copy its
 * config, revoke it, with axe on the empty state, the list and the dialog.
 * Focus returns to "Add agent" after each, which the vitest DOM cannot show
 * (Radix's close-time focus).
 */

/** The axe violations inside `selector`, by rule id. */
async function axeViolations(page: Page, selector: string): Promise<string[]> {
  return page.evaluate(async (scope) => {
    // @ts-expect-error injected global
    const results = await window.axe.run(document.querySelector(scope), {
      // Colour contrast follows the design tokens, not this card's structure.
      rules: { 'color-contrast': { enabled: false } },
    })
    return results.violations.map((v: { id: string }) => v.id)
  }, selector)
}

test.describe('Agents card', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Agent access' }).click()
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()
    await page.addScriptTag({ path: axePath })
  })

  test('adds an agent, lists it, and revokes it', async ({ page }) => {
    const rows = page.getByTestId('mcp-agent-row')
    await expect(page.getByText('No agents yet')).toBeVisible()
    await expect(rows).toHaveCount(0)
    expect(await axeViolations(page, '[data-testid="settings-panel-agent"]')).toEqual([])

    await page.getByRole('button', { name: 'Add agent' }).click()
    const dialog = activeDialog(page)
    await dialog.getByLabel('Name').fill('Planner')
    await dialog.getByRole('radio', { name: 'Read and write' }).click()
    expect(await axeViolations(page, '[data-slot="dialog-content"]')).toEqual([])
    await dialog.getByLabel('Name').press('Enter')

    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('Planner')
    await expect(rows).toContainText('Read and write')
    await expect(rows).toContainText('All spaces · Never used')
    await expect(page.getByRole('button', { name: 'Add agent' })).toBeFocused()
    expect(await axeViolations(page, '[data-testid="settings-panel-agent"]')).toEqual([])

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
    const token = await page.evaluate(async () => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string) => Promise<{ token: string }[]> }
        }
      ).__TAURI_INTERNALS__
      const [agent] = await internals.invoke('list_mcp_agents')
      return agent?.token ?? ''
    })
    expect(token).toMatch(/^agt_[0-9a-f]{32}$/)

    await page.getByRole('button', { name: 'Copy Claude Code command for Planner' }).click()
    await expect(page.getByText('Claude Code command copied')).toBeVisible()
    expect(await readClipboard(page)).toBe(
      `claude mcp add -s user agaric-planner-${await serverTail(page)} -- agaric-mcp --socket "/mock/agaric/mcp.sock" --token ${token}`,
    )

    await page.getByRole('button', { name: 'Copy Claude Desktop config for Planner' }).click()
    await expect(page.getByText('Claude Desktop config copied')).toBeVisible()
    const config = JSON.parse(await readClipboard(page)) as {
      mcpServers: Record<string, { command: string; args: string[] }>
    }
    expect(Object.values(config.mcpServers)).toEqual([
      {
        command: 'agaric-mcp',
        args: ['--socket', '/mock/agaric/mcp.sock', '--token', token],
      },
    ])
  })
})

/** The last six characters of the only agent's id, lowercased. */
async function serverTail(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: { invoke: (c: string) => Promise<{ id: string }[]> }
      }
    ).__TAURI_INTERNALS__
    const [agent] = await internals.invoke('list_mcp_agents')
    return (agent?.id ?? '').slice(-6).toLowerCase()
  })
}
