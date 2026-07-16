import { clearConsoleErrors, expect, getInvokeCalls, installIpcRecorder, test } from './helpers'

/**
 * E2E — Settings → Agent access (MCP) tab. (#2686)
 *
 * Before this spec, the AgentAccessTab surface (toggle, socket path, kill
 * switch, activity feed, session-revert controls) had zero e2e coverage —
 * only component-level unit tests (AgentAccessTab.test.tsx, ActivityFeed.test.tsx).
 *
 * UPDATE (#2683 fixed): the mock event bus now delivers events
 * (`shouldMockEvents: true` + `window.__emitMockEvent`), which unblocked
 * three of the four gaps originally documented here — live `mcp:activity`
 * delivery, non-empty feed content, and `SessionRevertControls`
 * reachability are now covered end-to-end in `mcp-activity-events.spec.ts`.
 *
 * The one gap that remains (orthogonal to the event bus):
 *
 *   - Persisted toggle state. `get_mcp_status` / `get_mcp_rw_status` are
 *     also pure functions that always answer `{ enabled: false, ... }` —
 *     the mock has no in-memory MCP state to mutate, so a toggle's optimistic
 *     "on" flips back to "off" once `loadStatus()` refetches. This is
 *     asserted explicitly below (not worked around) so a future change to
 *     the mock's statefulness is caught either way.
 */

test.describe('Agent access settings tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('tab', { name: 'Agent access' }).click()
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()
  })

  test('renders RO/RW status, socket paths, and kill-switch controls', async ({ page }) => {
    const roToggle = page.getByRole('switch', { name: 'Read-only access' })
    const rwToggle = page.getByRole('switch', { name: 'Read-write access' })
    await expect(roToggle).toBeVisible()
    await expect(roToggle).toHaveAttribute('aria-checked', 'false')
    await expect(rwToggle).toBeVisible()
    await expect(rwToggle).toHaveAttribute('aria-checked', 'false')

    await expect(page.locator('[data-testid="mcp-socket-path"]')).toHaveText(
      '/mock/agaric-mcp-ro.sock',
    )
    await expect(page.locator('[data-testid="mcp-rw-socket-path"]')).toHaveText(
      '/mock/agaric-mcp-rw.sock',
    )

    // Kill switches start disabled — the mock reports 0 active connections
    // for both channels. `exact: true` on the RO button: "Disconnect all"
    // is otherwise a substring match of "Disconnect all read-write" too.
    await expect(page.getByRole('button', { name: 'Disconnect all', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Disconnect all read-write' })).toBeDisabled()

    // Copy-config affordances (RO only).
    await expect(page.getByRole('button', { name: 'Copy Claude Desktop config' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copy generic MCP config' })).toBeVisible()
  })

  test('RO toggle fires mcp_set_enabled and shows a success toast', async ({ page }) => {
    await installIpcRecorder(page)
    const roToggle = page.getByRole('switch', { name: 'Read-only access' })

    await roToggle.click()

    // The IPC call fires with the requested next-state.
    await expect.poll(() => getInvokeCalls(page, 'mcp_set_enabled')).toEqual([{ enabled: true }])

    // Success toast confirms the round trip completed.
    await expect(page.getByText('Read-only agent access enabled')).toBeVisible()

    // See the file-header note: `get_mcp_status` is a stateless mock
    // handler that always answers `enabled: false`, so the post-toggle
    // `loadStatus()` refetch overwrites the optimistic `true` and the
    // switch settles back to unchecked. Asserted explicitly, not avoided.
    await expect(roToggle).toHaveAttribute('aria-checked', 'false')
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
    // `revert()` restores the pre-click snapshot — deterministic, unlike
    // the success path above (no refetch involved on the error branch).
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
    // them (see file-header note / #2683).
    await expect(page.locator('[data-testid="mcp-activity-feed"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="mcp-activity-row"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="mcp-activity-session-header"]')).toHaveCount(0)
  })
})
