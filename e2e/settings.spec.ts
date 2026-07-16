import { expect, test } from './helpers'

test.describe('Settings panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    // Wait for app to boot
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    // Navigate to Settings
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  })

  test('Settings view opens from sidebar', async ({ page }) => {
    // Tab bar should be visible
    await expect(page.getByRole('tablist')).toBeVisible()
  })

  // #2687 — SettingsView defines 10 tabs (TAB_IDS in SettingsView.tsx),
  // grouped into four rail sections (Workspace / Integrations / Data & Sync
  // / Help). This test used to check only 6 under a misleading "All 6 tabs"
  // title, silently never opening Editor, Notifications, Agent access, or
  // Help. Listed here in the same order as TAB_GROUPS so the loop below
  // walks the rail top-to-bottom.
  test('All 10 tabs are visible and clickable', async ({ page }) => {
    const tabNames = [
      // Workspace
      'General',
      'Appearance',
      'Editor',
      'Keyboard',
      'Properties',
      // Integrations
      'Notifications',
      'Agent access',
      // Data & Sync
      'Data',
      'Sync & Devices',
      // Help
      'Help',
    ]
    for (const name of tabNames) {
      const tab = page.getByRole('tab', { name })
      await expect(tab).toBeVisible()
      await tab.click()
      await expect(tab).toHaveAttribute('aria-selected', 'true')
    }
  })

  test('General tab is selected by default', async ({ page }) => {
    const generalTab = page.getByRole('tab', { name: 'General' })
    await expect(generalTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('[data-testid="settings-panel-general"]')).toBeVisible()
  })

  test('Theme selector shows options', async ({ page }) => {
    await page.getByRole('tab', { name: 'Appearance' }).click()
    await expect(page.locator('[data-testid="settings-panel-appearance"]')).toBeVisible()

    // Find and open the theme Select trigger
    const themeTrigger = page.getByRole('combobox', { name: 'Theme' })
    await expect(themeTrigger).toBeVisible()
    await themeTrigger.click()

    // Verify all 7 shipped theme options appear
    const themeNames = [
      'Light',
      'Dark',
      'System',
      'Solarized Light',
      'Solarized Dark',
      'Dracula',
      'One Dark Pro',
    ]
    for (const name of themeNames) {
      await expect(page.getByRole('option', { name, exact: true })).toBeVisible()
    }
  })

  test('Keyboard settings tab renders shortcut list', async ({ page }) => {
    await page.getByRole('tab', { name: 'Keyboard' }).click()
    await expect(page.locator('[data-testid="settings-panel-keyboard"]')).toBeVisible()
    await expect(page.locator('[data-testid="keyboard-settings-tab"]')).toBeVisible()

    // Should show the title and at least one kbd element (shortcut key).
    // `CardTitle` is a `<div>` (not a `<h2>`/`<h3>` — the card primitive
    // uses a styled div), so use a content locator instead of role=heading.
    await expect(page.getByText('Keyboard Shortcuts', { exact: true })).toBeVisible()
    await expect(page.locator('kbd').first()).toBeVisible()
  })

  test('Data settings tab renders controls', async ({ page }) => {
    await page.getByRole('tab', { name: 'Data' }).click()
    await expect(page.locator('[data-testid="settings-panel-data"]')).toBeVisible()

    // Import and Export panels should be visible
    await expect(page.locator('[data-testid="import-panel-title"]')).toBeVisible()
    await expect(page.locator('[data-testid="export-panel-title"]')).toBeVisible()
  })

  // #2687 — Editor tab was never opened by any spec that drives the actual
  // Settings UI (emoji-picker.spec.ts flips the underlying localStorage key
  // directly, bypassing this panel entirely).
  test('Editor tab renders its toggles and the emoji-picker toggle flips state', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Editor' }).click()
    await expect(page.locator('[data-testid="settings-panel-editor"]')).toBeVisible()

    const emojiToggle = page.locator('[data-testid="emoji-picker-toggle"]')
    const tabIndentToggle = page.locator('[data-testid="tab-indent-toggle"]')
    await expect(emojiToggle).toBeVisible()
    await expect(tabIndentToggle).toBeVisible()
    await expect(page.locator('[data-testid="external-image-policy-select"]')).toBeVisible()

    // Representative interaction: the emoji-picker toggle defaults on
    // (EMOJI_PICKER_ENABLED_KEY default `true`) and flips off on click —
    // no IPC involved, so the state change is synchronous and reliable.
    await expect(emojiToggle).toHaveAttribute('aria-checked', 'true')
    await emojiToggle.click()
    await expect(emojiToggle).toHaveAttribute('aria-checked', 'false')
  })

  // #2687 — Notifications tab was never opened by any spec.
  test('Notifications tab renders the enable toggle and gates the test-send button', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Notifications' }).click()
    await expect(page.locator('[data-testid="settings-panel-notifications"]')).toBeVisible()

    const enabledSwitch = page.locator('[data-testid="notifications-enabled-switch"]')
    const sendTestButton = page.locator('[data-testid="notifications-send-test-button"]')
    await expect(enabledSwitch).toBeVisible()
    await expect(
      page.locator('[data-testid="notifications-request-permission-button"]'),
    ).toBeVisible()

    // Representative interaction: "Send test notification" is disabled
    // until the enable toggle is on (`disabled={!enabled || testing}`).
    // Purely a localStorage-backed preference — no IPC round trip.
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(sendTestButton).toBeDisabled()
    await enabledSwitch.click()
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(sendTestButton).toBeEnabled()
  })

  // #2687 — Help tab was never opened by any spec (bug-report-dialog.spec.ts
  // dispatches the `agaric:report-bug` window event directly rather than
  // clicking the Settings → Help "Report a Bug" button).
  test('Help tab renders report-bug and update-check controls, and opens the bug-report dialog', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Help' }).click()
    await expect(page.locator('[data-testid="settings-panel-help"]')).toBeVisible()

    const reportBugButton = page.getByRole('button', { name: 'Report a bug' })
    await expect(reportBugButton).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check for updates now' })).toBeVisible()
    // The gesture-reference card (#1422) also lives on this tab. `exact:
    // true` — the card description also contains "touch gestures".
    await expect(page.getByText('Touch gestures', { exact: true })).toBeVisible()

    // Representative interaction: click through to the real dialog (rather
    // than dispatching the underlying window event directly, which is all
    // bug-report-dialog.spec.ts exercises).
    await reportBugButton.click()
    await expect(page.getByTestId('bug-report-body')).toBeVisible()
  })

  // #2687 / #2686 — Agent access tab was never opened by any spec. Deeper
  // toggle / activity-feed coverage lives in e2e/agent-access.spec.ts; this
  // is the tab-rail-level smoke check plus one representative interaction.
  test('Agent access tab renders MCP status controls and the RO toggle round-trips', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Agent access' }).click()
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()

    const roToggle = page.getByRole('switch', { name: 'Read-only access' })
    const rwToggle = page.getByRole('switch', { name: 'Read-write access' })
    await expect(roToggle).toBeVisible()
    await expect(rwToggle).toBeVisible()
    await expect(page.locator('[data-testid="mcp-socket-path"]')).toBeVisible()
    await expect(page.locator('[data-testid="mcp-rw-socket-path"]')).toBeVisible()

    await roToggle.click()
    await expect(page.getByText('Read-only agent access enabled')).toBeVisible()
  })

  // #2687 — the `?settings=<tab>` deep link (docs/features/views.md:114)
  // was never exercised by any spec.
  test('?settings=<tab> deep link is written to the URL and restored on reload', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Notifications' }).click()
    await expect(page.getByRole('tab', { name: 'Notifications' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(page.url()).toContain('settings=notifications')

    await page.reload()

    // The persisted `currentView` (localStorage, zustand) lands the app
    // back on Settings, and `readActiveTab()` reads the `?settings=` query
    // param (which outranks the separately-persisted active-tab
    // preference) to re-select Notifications without the user re-clicking.
    await expect(page.getByRole('button', { name: 'Journal', exact: true })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Notifications' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator('[data-testid="settings-panel-notifications"]')).toBeVisible()
  })

  test('Navigate away and back restores the last selected tab', async ({ page }) => {
    // Partial: SettingsView persists `activeTab` to localStorage under
    // `agaric-settings-active-tab` so navigating away and coming back keeps
    // the user's place, instead of remounting straight onto General. The
    // "General is selected on first visit" invariant lives in the
    // `General tab is selected by default` test above, which runs in a
    // fresh browser context with empty localStorage.

    // Switch to Appearance tab
    await page.getByRole('tab', { name: 'Appearance' }).click()
    await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Navigate away to Journal
    await page.getByRole('button', { name: 'Journal', exact: true }).click()
    // Wait until we're on the Journal view (Settings panel is gone)
    await expect(page.locator('[data-testid="settings-panel-appearance"]')).not.toBeVisible()

    // Navigate back to Settings — the previously selected Appearance tab
    // should still be active.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()

    await expect(page.getByRole('tab', { name: 'Appearance' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator('[data-testid="settings-panel-appearance"]')).toBeVisible()
    // And General should NOT be re-selected.
    await expect(page.getByRole('tab', { name: 'General' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
  })
})
