import {
  activeAlertDialog,
  activeDialog,
  clearConsoleErrors,
  expect,
  getInvokeCalls,
  installIpcRecorder,
  test,
  waitForBoot,
} from './helpers'

/**
 * E2E — sync pairing: completed pairing, failure/expiry, and the
 * no-peers → pairing entry point (#2704).
 *
 * `e2e/sync-ui.spec.ts:61-113` only ever asserts the PairingDialog opens,
 * shows the QR/passphrase, has 4 word inputs, and closes — it never
 * completes a pairing, never exercises failure/expiry, and never touches
 * unpair/rename/manual-address.
 *
 * ## Mock-blocked: peer management (list, unpair, rename, manual address)
 *
 * `src/lib/tauri-mock/handlers.ts` backs the entire peer surface with
 * STATELESS stubs, confirmed by direct inspection — there is no peer `Map`
 * anywhere in `src/lib/tauri-mock/seed.ts` (unlike `blocks`/`properties`/
 * `blockTags`/etc, which are all real, reseeded stores):
 *
 * ```
 * list_peer_refs: () => [],        // ALWAYS empty, never mutated
 * get_peer_ref: returnNull,
 * delete_peer_ref: returnUndefined,   // no-op
 * confirm_pairing: returnUndefined,   // no-op — never adds a peer
 * update_peer_name: returnUndefined,  // no-op
 * set_peer_address: returnNull,       // no-op
 * ```
 *
 * `DeviceManagement.tsx:111-130` and `PairingDialog.tsx:113-138,306-317`
 * both source their peer list EXCLUSIVELY from `listPeerRefs()`. Since that
 * handler is hardcoded to return `[]` and nothing in the mock ever populates
 * a backing store, a `PeerListItem` row can never render — there is no
 * "peer that appears in the device list" to assert on after a successful
 * pairing, and no row to unpair/rename/set an address on, regardless of how
 * pairing is driven. This is genuinely unreachable on the current mock, not
 * a missed test — see the `test.skip` at the bottom of this file. It is
 * already covered extensively at the unit layer (`PairingDialog.test.tsx`,
 * `DeviceManagement.test.tsx`, `PeerListItem.test.tsx`).
 *
 * What IS fully drivable and asserted below instead of "peer appears":
 * the `confirm_pairing` IPC call fires with the entered passphrase, the
 * success toast fires, and the dialog closes — the honest, observable
 * proxy for "pairing completed" under this mock.
 */

async function openPairNewDevice(page: import('@playwright/test').Page) {
  await waitForBoot(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('header').getByText('Settings')).toBeVisible()
  await page.getByRole('tab', { name: /Sync.*Devices/i }).click()
  await expect(page.locator('[data-testid="settings-panel-sync"]')).toBeVisible()
  await page.getByRole('button', { name: /pair new device/i }).click()
  const dialog = activeDialog(page)
  await expect(dialog.getByText('Pair Device')).toBeVisible()
  return dialog
}

async function fillPassphrase(
  dialog: ReturnType<typeof activeDialog>,
  words: [string, string, string, string],
) {
  const wordInputs = dialog.locator('input[aria-label*="Passphrase word"]')
  await expect(wordInputs).toHaveCount(4)
  for (let i = 0; i < 4; i++) {
    await wordInputs.nth(i).fill(words[i])
  }
}

test.describe.configure({ mode: 'serial' })

test.describe('Sync pairing flows', () => {
  test('entering the correct passphrase completes pairing: confirm_pairing fires, success toast, dialog closes', async ({
    page,
  }) => {
    const dialog = await openPairNewDevice(page)
    // Install AFTER boot — `installIpcRecorder` wraps
    // `window.__TAURI_INTERNALS__.invoke`, which the mock only installs
    // once the app has navigated/booted (helpers.ts:584-600); calling it
    // pre-navigation is a silent no-op.
    await installIpcRecorder(page)

    // Mock's start_pairing always returns this passphrase (handlers.ts ~3522).
    await fillPassphrase(dialog, ['alpha', 'bravo', 'charlie', 'delta'])
    await dialog.getByRole('button', { name: 'Pair', exact: true }).click()

    const calls = await getInvokeCalls(page, 'confirm_pairing')
    expect(calls.at(-1)?.['passphrase']).toBe('alpha bravo charlie delta')

    await expect(page.getByText('Device paired successfully')).toBeVisible()
    await expect(activeDialog(page)).toHaveCount(0)
  })

  test.describe('confirm_pairing failure', () => {
    test.afterEach(async ({ page }) => {
      await page.evaluate(() => {
        ;(window as unknown as { __clearMockErrors?: () => void }).__clearMockErrors?.()
      })
      // The injected failure flows through logger.error → console.error;
      // documented opt-out (helpers.ts:39-42, mirrors error-scenarios.spec.ts).
      clearConsoleErrors(page)
    })

    test('shows the error banner with a focused retry button, and retry re-initializes the session', async ({
      page,
    }) => {
      const dialog = await openPairNewDevice(page)

      await page.evaluate(() => {
        ;(
          window as unknown as {
            __injectMockError?: (cmd: string, msg: string) => void
          }
        ).__injectMockError?.('confirm_pairing', 'Handshake failed')
      })

      await fillPassphrase(dialog, ['alpha', 'bravo', 'charlie', 'delta'])
      await dialog.getByRole('button', { name: 'Pair', exact: true }).click()

      const errorBanner = dialog.locator('.pairing-error')
      await expect(errorBanner).toBeVisible()
      await expect(errorBanner).toContainText('Pairing failed: Handshake failed')

      // #430: focus moves to Retry on error.
      const retryBtn = dialog.locator('.pairing-retry-btn')
      await expect(retryBtn).toBeFocused()

      // Clear the injection and retry — re-runs `init()` (start_pairing +
      // listPeerRefs), which succeeds again and re-shows the QR/passphrase.
      await page.evaluate(() => {
        ;(window as unknown as { __clearMockErrors?: () => void }).__clearMockErrors?.()
      })
      await retryBtn.click()
      await expect(dialog.getByText(/alpha/i)).toBeVisible()
      await expect(errorBanner).toHaveCount(0)
    })
  })

  test('pairing session expiry shows "Session expired" and disables the form', async ({ page }) => {
    await waitForBoot(page)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(page.locator('header').getByText('Settings')).toBeVisible()
    await page.getByRole('tab', { name: /Sync.*Devices/i }).click()
    await expect(page.locator('[data-testid="settings-panel-sync"]')).toBeVisible()

    // Install the fake clock AFTER boot (seed data's `today` is already
    // computed from real time by then) so only the countdown's own
    // `setInterval` is affected.
    await page.clock.install()

    await page.getByRole('button', { name: /pair new device/i }).click()
    const dialog = activeDialog(page)
    await expect(dialog.getByText('Pair Device')).toBeVisible()
    await expect(dialog.locator('.pairing-countdown')).toContainText('5:00')

    // PAIRING_TIMEOUT_SECONDS is 300 (PairingDialog.tsx:54); run past it.
    // `runFor` (not `fastForward`) is required: the countdown decrements
    // via a 1000ms `setInterval` tick-by-tick, and `fastForward` only fires
    // a given due timer AT MOST ONCE (it "jumps" time, simulating a laptop
    // reopened later) — under it the interval fires exactly once and the
    // countdown only drops by one second. `runFor` replays every due tick,
    // matching real elapsed time.
    await page.clock.runFor('05:01')

    await expect(dialog.locator('.pairing-expired').getByText('Session expired')).toBeVisible()

    const wordInputs = dialog.locator('input[aria-label*="Passphrase word"]')
    await expect(wordInputs.first()).toBeDisabled()
    await expect(dialog.locator('.pairing-pair-btn')).toBeDisabled()
    await expect(dialog.locator('.pairing-retry-expired-btn')).toBeVisible()
  })

  test('Sync button with no paired devices opens NoPeersDialog and its CTA opens Sync settings', async ({
    page,
  }) => {
    await waitForBoot(page)

    // list_peer_refs is always [] (see file header) — the sidebar Sync
    // click guard (App.tsx:329-348) therefore ALWAYS opens NoPeersDialog
    // rather than silently syncing, on every run of this mock.
    const syncBtn = page
      .locator('[data-slot="sidebar"]')
      .getByRole('button', { name: 'Sync', exact: true })
    await expect(syncBtn).toBeEnabled()
    await syncBtn.click()

    const dialog = activeAlertDialog(page)
    await expect(dialog).toBeVisible()
    await expect(page.getByTestId('no-peers-dialog')).toBeVisible()
    await expect(dialog.getByText('No devices paired')).toBeVisible()

    await page.getByTestId('no-peers-dialog-open-settings').click()

    await expect(dialog).toHaveCount(0)
    await expect(page.locator('header').getByText('Settings')).toBeVisible()
    await expect(page.getByRole('tab', { name: /Sync.*Devices/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await expect(page.locator('[data-testid="settings-panel-sync"]')).toBeVisible()
  })

  // See the file-header note: `list_peer_refs` (handlers.ts ~3517) and
  // `confirm_pairing`/`delete_peer_ref`/`update_peer_name`/`set_peer_address`
  // (handlers.ts ~3519,3526,4067,4472) are all stateless no-op stubs with no
  // backing store, so a peer row can never render in DeviceManagement or the
  // PairingDialog's own peers list under this mock — there is nothing to
  // unpair, rename, or set a manual address on. Covered at the unit layer
  // instead (DeviceManagement.test.tsx:249/829, PeerListItem.test.tsx:155).
  test.skip('peer management (unpair / rename / manual address)', () => {
    // Structurally unreachable on the web+mock harness — see file header.
  })
})
