import { clearConsoleErrors, expect, getInvokeCalls, installIpcRecorder, test } from './helpers'

/**
 * E2E — Settings → Agent access (MCP) tab. (#2686)
 *
 * The switch, the socket path, the kill switch and the activity feed's
 * empty state; the agents card is `mcp-agents.spec.ts`. Live
 * `mcp:activity` delivery, non-empty feed content, and
 * `SessionRevertControls` are covered end-to-end in
 * `mcp-activity-events.spec.ts`.
 *
 * The mock keeps the switch's state in memory, so `get_mcp_status` reports
 * the last toggle and the gated section stays revealed after `loadStatus()`
 * refetches. It never reports a connection, so "Disconnect all" never
 * renders here.
 */

test.describe('Agent access settings tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Agent access' }).click()
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()
  })

  test('the switch reveals the socket path and connections', async ({ page }) => {
    const toggle = page.getByRole('switch', { name: 'Let agents connect' })
    const socket = page.locator('[data-testid="mcp-socket-path"]')
    await expect(toggle).toHaveAttribute('aria-checked', 'false')

    // Off: only the switch (and the agents and activity cards) render.
    await expect(socket).toHaveCount(0)
    await expect(page.getByText('No active connections.')).toHaveCount(0)

    await toggle.click()
    await expect(socket).toHaveText('/mock/agaric/mcp.sock')
    await expect(page.getByText('No active connections.')).toBeVisible()

    // The mock reports 0 active connections, so the kill switch does not render.
    await expect(page.getByRole('button', { name: 'Disconnect all' })).toHaveCount(0)
  })

  test('the switch fires mcp_set_enabled and shows a success toast', async ({ page }) => {
    await installIpcRecorder(page)
    const toggle = page.getByRole('switch', { name: 'Let agents connect' })

    await toggle.click()

    // The IPC call fires with the requested next-state.
    await expect.poll(() => getInvokeCalls(page, 'mcp_set_enabled')).toEqual([{ enabled: true }])

    // Success toast confirms the round trip completed.
    await expect(page.getByText('Agent access enabled')).toBeVisible()

    // The post-toggle `loadStatus()` refetch reads the mock's new state.
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('a failed toggle reverts the optimistic state and shows an error toast', async ({
    page,
  }) => {
    await page.evaluate(() => {
      ;(
        window as unknown as { __injectMockError?: (cmd: string, message: string) => void }
      ).__injectMockError?.('mcp_set_enabled', 'backend exploded')
    })

    const toggle = page.getByRole('switch', { name: 'Let agents connect' })
    await toggle.click()

    await expect(page.getByText('Failed to toggle agent access')).toBeVisible()
    // `revert()` restores the pre-click snapshot (no refetch on the error branch).
    await expect(toggle).toHaveAttribute('aria-checked', 'false')

    // This test deliberately drives the IPC-rejection path, which logs via
    // `logger.error` (console.error) per AGENTS.md's error-path convention
    // — the same documented opt-out error-scenarios.spec.ts uses.
    clearConsoleErrors(page)
  })

  test('activity feed renders the empty state', async ({ page }) => {
    await expect(
      page.getByText('No agent activity yet. When an agent connects, tool calls appear here.'),
    ).toBeVisible()

    // The populated-feed container, the per-entry Undo button, and the
    // session-revert header never render — there is no data to trigger
    // them (see file-header note / #2683). The feed shows with the switch
    // off: its Undo reverts past agent writes after access is turned off.
    await expect(page.locator('[data-testid="mcp-activity-feed"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="mcp-activity-row"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="mcp-activity-session-header"]')).toHaveCount(0)
  })
})
