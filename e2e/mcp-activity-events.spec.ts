import { expect, test } from './helpers'

/**
 * E2E — live `mcp:activity` events into the Agent access settings tab
 * (#2683, unblocking #2686's documented gaps).
 *
 * `useMcpActivityFeed` (`src/hooks/useMcpActivityFeed.ts`) subscribes to the
 * `mcp:activity` Tauri event via `listen()` and appends each delivered
 * `ActivityEntry` to the feed shown by `ActivityFeed`
 * (`src/components/agent-access/ActivityFeed.tsx`). Before #2683 the
 * tauri-mock never delivered an event to a registered `listen()` callback,
 * so this whole surface — and everything gated on it — was structurally
 * untestable:
 *
 *   1. Live `mcp:activity` delivery into the feed — UNBLOCKED here (first
 *      test): `window.__emitMockEvent('mcp:activity', entry)` now reaches
 *      the hook's `listen()` callback exactly as a real backend event would.
 *   2. Non-empty feed content — UNBLOCKED as a side effect: the feed's
 *      `entries` state is populated ENTIRELY by live events (see
 *      `useMcpActivityFeed.ts`'s `setEntries` in the `listen()` handler) —
 *      `get_mcp_recent_activity` (the mock's stateless backfill handler,
 *      always `[]`) is irrelevant to this path.
 *   3. `SessionRevertControls` (renders only when a session accumulates
 *      ≥ 2 undoable ops) — UNBLOCKED here (second test): two `mcp:activity`
 *      events sharing a `sessionId`, both agent-authored RW successes with
 *      an `opRef`, are enough to cross the ≥ 2 threshold purely via events.
 *   4. Persisted toggle state (`mcp_set_enabled` optimistic flip reverting
 *      because `get_mcp_status` is a stateless mock handler) — STILL
 *      BLOCKED. That gap is orthogonal to the event bus (#2683's fix
 *      doesn't touch command statefulness) and is out of scope here.
 */

interface MockEventWindow extends Window {
  __emitMockEvent?: (event: string, payload?: unknown) => Promise<void>
}

async function emitMockEvent(
  page: import('@playwright/test').Page,
  event: string,
  payload: unknown,
) {
  await page.evaluate(
    ({ event: evt, payload: data }) =>
      (window as unknown as MockEventWindow).__emitMockEvent?.(evt, data),
    { event, payload },
  )
}

async function openAgentAccessTab(page: import('@playwright/test').Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('tab', { name: 'Agent access' }).click()
  await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()
}

test.describe('mcp:activity live events (#2683 / #2686)', () => {
  test('a live mcp:activity event populates the previously-empty feed', async ({ page }) => {
    await openAgentAccessTab(page)

    // Empty state renders before any activity arrives — `get_mcp_recent_activity`
    // is a stateless mock handler that always answers `[]`.
    await expect(page.getByText('No agent activity yet.', { exact: false })).toBeVisible()

    await emitMockEvent(page, 'mcp:activity', {
      toolName: 'search_blocks',
      summary: 'Searched for "quarterly report"',
      timestamp: new Date().toISOString(),
      actorKind: 'agent',
      agentName: 'claude',
      result: { kind: 'ok' },
      sessionId: 'session-1',
    })

    await expect(page.locator('[data-testid="mcp-activity-row"]')).toHaveCount(1)
    await expect(page.getByText('Searched for "quarterly report"')).toBeVisible()
  })

  test('two agent-authored RW ops in one session render the bulk-revert session header', async ({
    page,
  }) => {
    await openAgentAccessTab(page)

    const now = Date.now()
    await emitMockEvent(page, 'mcp:activity', {
      toolName: 'append_block',
      summary: 'Appended a block to "Quick Notes"',
      timestamp: new Date(now).toISOString(),
      actorKind: 'agent',
      agentName: 'claude',
      result: { kind: 'ok' },
      sessionId: 'session-2',
      opRef: { device_id: 'device-a', seq: 1 },
    })
    await emitMockEvent(page, 'mcp:activity', {
      toolName: 'update_block_content',
      summary: 'Updated a block in "Quick Notes"',
      timestamp: new Date(now + 1000).toISOString(),
      actorKind: 'agent',
      agentName: 'claude',
      result: { kind: 'ok' },
      sessionId: 'session-2',
      opRef: { device_id: 'device-a', seq: 2 },
    })

    await expect(page.locator('[data-testid="mcp-activity-row"]')).toHaveCount(2)

    const sessionHeader = page.locator('[data-testid="mcp-activity-session-header"]')
    await expect(sessionHeader).toBeVisible()
    await expect(sessionHeader).toHaveAttribute('data-session-id', 'session-2')
    await expect(page.locator('[data-testid="mcp-activity-revert-session"]')).toBeVisible()
  })
})
