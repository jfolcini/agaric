import { expect, test } from './helpers'

/**
 * E2E — `agaric://` deep-link routing (#2683).
 *
 * `useDeepLinkRouter` (mounted globally in `App.tsx`) listens for three
 * backend events — `deeplink:navigate-to-block`, `deeplink:navigate-to-page`,
 * `deeplink:open-settings` — via `@tauri-apps/api/event`'s `listen()`. Before
 * #2683, the tauri-mock's `plugin:event|listen` / `|emit` were no-ops, so no
 * spec could ever fire one of these events and this whole navigation surface
 * had zero e2e coverage.
 *
 * `setupMock()` now exposes `window.__emitMockEvent(event, payload)`
 * (`src/lib/tauri-mock/index.ts`), which goes through the real
 * `@tauri-apps/api/event` `emit()` — delivered to `listen()` callbacks via
 * `mockIPC`'s built-in `shouldMockEvents` event bus.
 *
 * Event payload shapes mirror the Rust router
 * (`src-tauri/src/deeplink/mod.rs`, see `useDeepLinkRouter.ts` header):
 *   - `deeplink:navigate-to-page` → `{ id: <ULID> }`
 *   - `deeplink:open-settings` → `{ tab: <tab name> }`
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

// Seed id — see src/lib/tauri-mock/seed.ts SEED_IDS.PAGE_QUICK_NOTES.
const PAGE_QUICK_NOTES = '00000000000000000000PAGE02'

test.describe('deep-link routing (#2683)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
  })

  test('deeplink:navigate-to-page event navigates to the target page', async ({ page }) => {
    await emitMockEvent(page, 'deeplink:navigate-to-page', { id: PAGE_QUICK_NOTES })

    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Quick Notes', {
      timeout: 5000,
    })
  })

  test('deeplink:open-settings event with tab "agent" opens the Agent access tab', async ({
    page,
  }) => {
    await emitMockEvent(page, 'deeplink:open-settings', { tab: 'agent' })

    await expect(page.getByRole('tab', { name: 'Agent access' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()
  })
})
