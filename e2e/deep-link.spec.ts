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

// Seed id — see src/lib/tauri-mock/seed.ts SEED_IDS.PAGE_GETTING_STARTED.
const PAGE_GETTING_STARTED = '00000000000000000000PAGE01'
const SWITCH_SPACE = 'Switch space'

/** Open the SpaceSwitcher dropdown and select an option by its accessible name. */
async function selectSwitcherOption(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('combobox', { name: SWITCH_SPACE, exact: true }).click()
  // Move off the trigger so its hover tooltip cannot sit over the option list
  // (see e2e/spaces-management.spec.ts for the observed flake).
  await page.mouse.move(0, 0)
  await page.getByRole('option', { name, exact: true }).click()
}

test.describe('deep-link routing across spaces (#5415)', () => {
  test('a link to a page in another space switches to that space and opens it', async ({
    page,
  }) => {
    await page.goto('/')
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()

    // Create "Work" and move Getting Started into it; the active space stays Personal.
    await selectSwitcherOption(page, 'Manage spaces…')
    const panel = page.getByTestId('settings-panel-spaces')
    await expect(panel).toBeVisible()
    await panel.getByRole('button', { name: 'Create new space', exact: true }).click()
    await panel.getByPlaceholder('New space name').fill('Work')
    await panel.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(panel.getByRole('textbox', { name: 'Rename space' }).last()).toHaveValue('Work')

    await emitMockEvent(page, 'deeplink:navigate-to-page', { id: PAGE_GETTING_STARTED })
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
    await page.getByRole('button', { name: 'Page actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Move to space', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Work', exact: true }).click()
    await expect(page.getByText('Page moved to Work', { exact: true })).toBeVisible()
    await expect(page.getByRole('combobox', { name: SWITCH_SPACE, exact: true })).toContainText(
      'Personal',
    )

    // The same link now lands in Work: the router resolved the page's own space.
    await emitMockEvent(page, 'deeplink:navigate-to-page', { id: PAGE_GETTING_STARTED })
    await expect(page.getByRole('combobox', { name: SWITCH_SPACE, exact: true })).toContainText(
      'Work',
    )
    await expect(page.locator('[aria-label="Page title"]')).toHaveText('Getting Started')
  })
})
