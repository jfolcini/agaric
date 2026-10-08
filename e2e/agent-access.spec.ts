import { clearConsoleErrors, expect, getInvokeCalls, installIpcRecorder, test } from './helpers'

/**
 * E2E — Settings → Agent access (MCP) tab. (#2686)
 *
 * Before this spec, the AgentAccessTab surface (toggle, socket path, kill
 * switch, activity feed, session-revert controls) had zero e2e coverage —
 * only component-level unit tests (AgentAccessTab.test.tsx, ActivityFeed.test.tsx).
 *
 * Live `mcp:activity` delivery, non-empty feed content, and
 * `SessionRevertControls` are covered end-to-end in
 * `mcp-activity-events.spec.ts`.
 *
 * The mock keeps each channel's on/off flag in memory, so `get_mcp_status` /
 * `get_mcp_rw_status` report the last toggle and the gated sections stay
 * revealed after `loadStatus()` refetches. It never reports a connection, so
 * the "Disconnect all" buttons never render here.
 */

test.describe('Agent access settings tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Agent access' }).click()
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()
  })

  test('each toggle reveals its socket path, config and connections', async ({ page }) => {
    const roToggle = page.getByRole('switch', { name: 'Read-only access' })
    const rwToggle = page.getByRole('switch', { name: 'Read-write access' })
    const roSocket = page.locator('[data-testid="mcp-socket-path"]')
    const rwSocket = page.locator('[data-testid="mcp-rw-socket-path"]')
    const claudeConfig = page.getByRole('button', { name: 'Copy Claude Desktop config' })
    await expect(roToggle).toHaveAttribute('aria-checked', 'false')
    await expect(rwToggle).toHaveAttribute('aria-checked', 'false')

    // Off: only the toggles (and the activity feed) render.
    await expect(roSocket).toHaveCount(0)
    await expect(rwSocket).toHaveCount(0)
    await expect(claudeConfig).toHaveCount(0)

    await roToggle.click()
    await expect(roSocket).toHaveText('/mock/agaric-mcp-ro.sock')
    await expect(claudeConfig).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copy Claude Code commands' })).toBeVisible()
    await expect(page.getByText('No active connections.')).toBeVisible()
    await expect(rwSocket).toHaveCount(0)

    await rwToggle.click()
    await expect(rwSocket).toHaveText('/mock/agaric-mcp-rw.sock')
    await expect(page.getByText('No active read-write connections.')).toBeVisible()

    // The mock reports 0 active connections, so neither kill switch renders.
    await expect(page.getByRole('button', { name: /^Disconnect all/ })).toHaveCount(0)
  })

  test('RO toggle fires mcp_set_enabled and shows a success toast', async ({ page }) => {
    await installIpcRecorder(page)
    const roToggle = page.getByRole('switch', { name: 'Read-only access' })

    await roToggle.click()

    // The IPC call fires with the requested next-state.
    await expect.poll(() => getInvokeCalls(page, 'mcp_set_enabled')).toEqual([{ enabled: true }])

    // Success toast confirms the round trip completed.
    await expect(page.getByText('Read-only agent access enabled')).toBeVisible()

    // The post-toggle `loadStatus()` refetch reads the mock's new state.
    await expect(roToggle).toHaveAttribute('aria-checked', 'true')
  })

  test('RW toggle fires mcp_rw_set_enabled independently of the RO toggle', async ({ page }) => {
    await installIpcRecorder(page)
    const roToggle = page.getByRole('switch', { name: 'Read-only access' })
    const rwToggle = page.getByRole('switch', { name: 'Read-write access' })

    await rwToggle.click()

    await expect.poll(() => getInvokeCalls(page, 'mcp_rw_set_enabled')).toEqual([{ enabled: true }])
    // The RO channel's command must not have fired.
    expect(await getInvokeCalls(page, 'mcp_set_enabled')).toEqual([])

    await expect(page.getByText('Read-write agent access enabled')).toBeVisible()
    // RO toggle is untouched by the RW round trip.
    await expect(roToggle).toHaveAttribute('aria-checked', 'false')
  })

  test('a failed RO toggle reverts the optimistic state and shows an error toast', async ({
    page,
  }) => {
    await page.evaluate(() => {
      ;(
        window as unknown as { __injectMockError?: (cmd: string, message: string) => void }
      ).__injectMockError?.('mcp_set_enabled', 'backend exploded')
    })

    const roToggle = page.getByRole('switch', { name: 'Read-only access' })
    await roToggle.click()

    await expect(page.getByText('Failed to toggle agent access')).toBeVisible()
    // `revert()` restores the pre-click snapshot (no refetch on the error branch).
    await expect(roToggle).toHaveAttribute('aria-checked', 'false')

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
    // them (see file-header note / #2683). The feed shows with both toggles
    // off: its Undo reverts past agent writes after access is turned off.
    await expect(page.locator('[data-testid="mcp-activity-feed"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="mcp-activity-row"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="mcp-activity-session-header"]')).toHaveCount(0)
  })
})
