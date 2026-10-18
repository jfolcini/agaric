import { expect, test } from './helpers'

test.describe('Settings panel @settings', () => {
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

  // #2687 / #5629 — every tab in `TAB_GROUPS` order, so the rail reads
  // top-to-bottom exactly as listed here.
  test('the rail lists all 12 tabs in order, and each is clickable', async ({ page }) => {
    const tabNames = [
      // Workspace
      'General',
      'Appearance',
      'Editor',
      'Keyboard',
      'Tasks & reminders',
      'Spaces',
      'Properties',
      // Integrations
      'Agent access',
      // Data & sync
      'Sync & devices',
      'Data',
      // Help
      'About',
      'App health',
    ]
    await expect(page.getByRole('tab')).toHaveText(tabNames)
    for (const name of tabNames) {
      const tab = page.getByRole('tab', { name, exact: true })
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

    // The tab names the panel, so it has no title of its own (#5345).
    await expect(page.getByRole('button', { name: 'Reset all to defaults' })).toBeVisible()
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

  // #2687 — Notifications tab was never opened by any spec. #5629 — it is
  // Tasks & reminders now, and holds the deadline warning too.
  test('Tasks & reminders tab renders the enable toggle and gates the test-send button', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Tasks & reminders' }).click()
    await expect(page.locator('[data-testid="settings-panel-notifications"]')).toBeVisible()
    await expect(page.getByRole('spinbutton', { name: 'Deadline warning' })).toBeVisible()

    const enabledSwitch = page.locator('[data-testid="notifications-enabled-switch"]')
    const sendTestButton = page.locator('[data-testid="notifications-send-test-button"]')
    await expect(enabledSwitch).toBeVisible()
    await expect(
      page.locator('[data-testid="notifications-request-permission-button"]'),
    ).toBeVisible()

    // Representative interaction: "Send test notification" and the reminder
    // time are disabled until the switch is on (`disabled={!enabled}`).
    // #4554 — the preference is backend state now (`set_reminder_settings`),
    // so leaving and re-entering the tab must re-read it as on.
    const reminderTime = page.locator('[data-testid="notifications-reminder-time"]')
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(sendTestButton).toBeDisabled()
    await expect(reminderTime).toBeDisabled()
    await enabledSwitch.click()
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(sendTestButton).toBeEnabled()
    await expect(reminderTime).toBeEnabled()

    await page.getByRole('tab', { name: 'General' }).click()
    await page.getByRole('tab', { name: 'Tasks & reminders' }).click()
    await expect(enabledSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(reminderTime).toHaveValue('09:00')
  })

  // #2687 — About tab (Help group) was never opened by any spec (bug-report-dialog.spec.ts
  // dispatches the `agaric:report-bug` window event directly rather than
  // clicking the Settings › Help › About "Report a Bug" button).
  test('About tab renders report-bug and update-check controls, and opens the bug-report dialog', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'About' }).click()
    await expect(page.locator('[data-testid="settings-panel-help"]')).toBeVisible()

    const reportBugButton = page.getByRole('button', { name: 'Report a bug' })
    await expect(reportBugButton).toBeVisible()
    await expect(page.getByRole('button', { name: 'Check for updates now' })).toBeVisible()

    // Representative interaction: click through to the real dialog (rather
    // than dispatching the underlying window event directly, which is all
    // bug-report-dialog.spec.ts exercises).
    await reportBugButton.click()
    await expect(page.getByTestId('bug-report-body')).toBeVisible()
  })

  // #5360 — the result of a Run in App health rides along with a bug report
  // filed from Help. #5629 — sync status moved out to Sync & devices.
  test('App health runs the integrity check and a bug report from Help carries it', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'App health' }).click()
    const panel = page.locator('[data-testid="settings-panel-status"]')
    await expect(panel.getByText('Materializer status')).toBeVisible()
    await expect(panel.getByTestId('sync-panel-title')).toHaveCount(0)

    await panel.getByRole('button', { name: 'Run check' }).click()
    await expect(panel.getByText('Everything matches')).toBeVisible()

    await page.getByRole('tab', { name: 'About' }).click()
    await page.getByRole('button', { name: 'Report a bug' }).click()
    await expect(page.getByTestId('bug-report-preview')).toContainText('## Integrity check')
  })

  // The mock has no derived tables to diverge, so this stubs the one IPC to
  // hand back the diverged result a real vault can produce.
  test('a diverged integrity check opens a bug report that carries it', async ({ page }) => {
    await page.evaluate(() => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }
        }
      ).__TAURI_INTERNALS__
      const invoke = internals.invoke.bind(internals)
      internals.invoke = (c, a) =>
        c === 'compute_reconciliation_report'
          ? Promise.resolve({
              blocks_scanned: 1865,
              today: '2026-10-19',
              total_divergences: 2,
              artefacts: [
                {
                  artefact: 'pages_cache.last_edited_ms',
                  count: 2,
                  sample_keys: ['01M5500000000000000000000A', '01M5500000000000000000000B'],
                },
              ],
            })
          : invoke(c, a)
    })
    await page.getByRole('tab', { name: 'App health' }).click()
    const panel = page.locator('[data-testid="settings-panel-status"]')
    await panel.getByRole('button', { name: 'Run check' }).click()
    await expect(panel.getByTestId('integrity-summary')).toBeVisible()

    await panel.getByRole('button', { name: 'Report a bug' }).click()

    await expect(page.getByLabel('Short title')).toHaveValue('Integrity check: 2 divergences')
    await expect(page.getByTestId('bug-report-preview')).toContainText(
      '2 divergences over 1865 blocks scanned, 2026-10-19.',
    )
  })

  // #2687 / #2686 — Agent access tab was never opened by any spec. Deeper
  // toggle / activity-feed coverage lives in e2e/agent-access.spec.ts; this
  // is the tab-rail-level smoke check plus one representative interaction.
  test('Agent access tab renders the MCP switch and it round-trips', async ({ page }) => {
    await page.getByRole('tab', { name: 'Agent access' }).click()
    await expect(page.locator('[data-testid="settings-panel-agent"]')).toBeVisible()

    const toggle = page.getByRole('switch', { name: 'Let agents connect' })
    const socket = page.locator('[data-testid="mcp-socket-path"]')
    await expect(toggle).toBeVisible()
    // The socket path shows only while the switch is on.
    await expect(socket).toHaveCount(0)

    await toggle.click()
    await expect(page.getByText('Agent access enabled')).toBeVisible()
    await expect(socket).toBeVisible()
  })

  // #2687 — the `?settings=<tab>` deep link (docs/features/views.md:114)
  // was never exercised by any spec.
  test('?settings=<tab> deep link is written to the URL and restored on reload', async ({
    page,
  }) => {
    await page.getByRole('tab', { name: 'Tasks & reminders' }).click()
    await expect(page.getByRole('tab', { name: 'Tasks & reminders' })).toHaveAttribute(
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
    await expect(page.getByRole('tab', { name: 'Tasks & reminders' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator('[data-testid="settings-panel-notifications"]')).toBeVisible()
  })

  // #5629 — the Edit history tab became a row in Data; its old links land
  // there instead of on a blank panel.
  test('an old ?settings=history link lands on Data, whose row opens History', async ({ page }) => {
    await page.goto('/?settings=history')

    await expect(page.getByRole('tab', { name: 'Data', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(page.url()).toContain('settings=data')
    await page.getByRole('button', { name: 'Open edit history', exact: true }).click()
    await expect(page.getByTestId('header-label')).toHaveText('History')
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
