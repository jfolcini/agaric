import type { Page } from '@playwright/test'

import {
  activeDialog,
  clearConsoleErrors,
  expect,
  getConsoleErrors,
  navigateToView,
  openSettingsTab,
  test,
  waitForBoot,
} from './helpers'

/**
 * Settings › Help (#5741): the debug-mode switch, the welcome-tour reset and
 * the manual update check, each driven from the About tab and judged by what
 * the user then sees. All three are frontend state the mock can show failing.
 */

async function openAbout(page: Page): Promise<void> {
  await navigateToView(page, 'Settings')
  await openSettingsTab(page, 'About')
  await expect(page.getByTestId('settings-panel-help')).toBeVisible()
}

/** Pair as the joiner with any passphrase and return the error banner's message. */
async function failPairing(page: Page) {
  await openSettingsTab(page, 'Sync & devices')
  await page.getByRole('button', { name: /pair new device/i }).click()
  const dialog = activeDialog(page)
  await dialog.getByRole('button', { name: /have a code from the other device/i }).click()
  const words = dialog.locator('input[aria-label*="Passphrase word"]')
  await expect(words).toHaveCount(4)
  for (const [i, word] of ['alpha', 'bravo', 'charlie', 'delta'].entries()) {
    await words.nth(i).fill(word)
  }
  await dialog.getByRole('button', { name: 'Pair', exact: true }).click()
  return dialog.getByRole('alert').locator('p')
}

/**
 * Answer the updater plugin's `check` as the release server would: `null` is
 * "no newer release", metadata is an available one. The mock rejects every
 * `plugin:updater|*` call by design (`PLUGIN_HANDLERS` in
 * src/lib/tauri-mock/handlers.ts), so the spec stands in for the server by
 * wrapping the live `invoke`, as `installIpcRecorder` does.
 */
async function answerUpdateCheck(page: Page, answer: Record<string, unknown> | null) {
  await page.evaluate((next) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: Record<string, unknown>
      __updateCheckAnswer?: unknown
      __updateCheckWrapped?: boolean
    }
    w.__updateCheckAnswer = next
    if (w.__updateCheckWrapped) return
    w.__updateCheckWrapped = true
    const internals = w.__TAURI_INTERNALS__
    const original = internals['invoke'] as (c: string, a?: unknown, o?: unknown) => unknown
    internals['invoke'] = (cmd: string, args?: unknown, opts?: unknown) =>
      cmd === 'plugin:updater|check'
        ? Promise.resolve(w.__updateCheckAnswer)
        : original(cmd, args, opts)
  }, answer)
}

test.describe('Settings › Help @settings', () => {
  test.beforeEach(async ({ page }) => {
    await waitForBoot(page)
  })

  test('debug mode appends the error kind to a failure message, and off drops it', async ({
    page,
  }) => {
    // Every toast is handed translated copy, so the kind shows on an inline
    // banner that formats the raw rejection: the pairing dialog's.
    await page.evaluate(() => {
      ;(
        window as unknown as { __injectMockError: (cmd: string, err: unknown) => void }
      ).__injectMockError('confirm_pairing', {
        kind: 'invalid_operation',
        message: 'Invalid operation: the code was already used',
      })
    })
    const debugSwitch = page.getByRole('switch', { name: 'Debug mode' })

    await openAbout(page)
    await debugSwitch.click()
    await expect(debugSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(await failPairing(page)).toHaveText(
      'Pairing failed: the code was already used · code: invalid_operation',
    )
    await page.keyboard.press('Escape')
    await expect(activeDialog(page)).toHaveCount(0)

    await openSettingsTab(page, 'About')
    await debugSwitch.click()
    await expect(debugSwitch).toHaveAttribute('aria-checked', 'false')
    await expect(await failPairing(page)).toHaveText('Pairing failed: the code was already used')

    // Each failed pair logs the rejection.
    expect(getConsoleErrors(page).filter((e) => e.includes('Pairing failed'))).toHaveLength(2)
    clearConsoleErrors(page)
  })

  test('Show tour reopens the welcome modal, and closing it marks onboarding done', async ({
    page,
  }) => {
    const welcome = page.getByTestId('welcome-modal')
    await openAbout(page)
    await page.getByRole('button', { name: 'Show tour', exact: true }).click()
    await expect(welcome).toBeVisible()
    await expect(welcome.getByText('Welcome to Agaric', { exact: true })).toBeVisible()

    await welcome.getByRole('button', { name: 'Get Started', exact: true }).click()
    await expect(welcome).toHaveCount(0)

    // The next launch mounts the modal only without this flag (`useWelcomeGate`,
    // pinned in App.test.tsx). Its absence on a fresh boot is no evidence: the
    // modal is a lazy chunk, and nothing on screen says the chunk was never asked for.
    await expect
      .poll(() => page.evaluate(() => window.localStorage.getItem('agaric-onboarding-done')))
      .toBe('true')
  })

  test('Check for updates now reports up to date, then an available release', async ({ page }) => {
    await openAbout(page)
    const button = page.getByRole('button', { name: 'Check for updates now' })
    const status = page.getByTestId('settings-panel-help').getByRole('status')
    const toast = (text: string) => page.locator('[data-sonner-toast]').filter({ hasText: text })
    // The boot check fails on the mock; its outcome on the card means it is
    // over, so a click cannot join it and inherit its silence.
    await expect(status).toHaveText(/^Last check failed/)

    await answerUpdateCheck(page, null)
    await button.click()
    await expect(toast("You're on the latest version")).toBeVisible()
    await expect(status).toHaveText('Up to date')

    await answerUpdateCheck(page, {
      rid: 1,
      currentVersion: '1.0.0',
      version: '9.9.9',
      date: null,
      body: '',
      rawJson: {},
    })
    await button.click()
    await expect(toast('Agaric 9.9.9 is available')).toBeVisible()
    await expect(status).toHaveText('Update available: v9.9.9')
  })
})
