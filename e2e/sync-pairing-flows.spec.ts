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
 * ## The peer surface is stateful now (#3469)
 *
 * This header used to record the peer surface as STATELESS — `list_peer_refs:
 * () => []` with no backing store, `confirm_pairing: returnUndefined, // no-op
 * — never adds a peer` — and concluded that a `PeerListItem` row could never
 * render, so "a peer appears in the device list" was unassertable here. That
 * is no longer true: `src/lib/tauri-mock/seed.ts` now owns a real `peerRefs`
 * Map (reseeded like `blocks`/`properties`), and `handlers/sync.ts` reads and
 * writes it.
 *
 * What the mock models, precisely:
 *
 * ```
 * list_peer_refs: reads the peerRefs store, and advances a pending reveal
 * get_peer_ref / delete_peer_ref: read / remove from that same store
 * confirm_pairing: arms a pending reveal — adds NO peer synchronously
 * update_peer_name / set_peer_address: still no-ops
 * ```
 *
 * The reveal timing is the load-bearing part, and it is COUNTED IN READS,
 * not scheduled on a timer (a `setTimeout` would desync from the
 * `page.clock` this file's tests install). A `confirm_pairing` arms a
 * three-read countdown; the peer materializes on the third subsequent
 * `list_peer_refs`. The first two are the joiner's own pre-tick reads —
 * `PairingDialog`'s authoritative baseline snapshot (taken inside
 * `executePair`'s `call`, right after `confirm_pairing` resolves) and
 * `usePollingQuery`'s immediate fetch when polling is enabled — and BOTH
 * must come back empty, or the flow breaks: a peer in the baseline can
 * never read as "new", so the wait would deadlock for the full 5-minute
 * TTL; a peer in the immediate fetch would resolve the wait in the frame it
 * opened, which is the pre-#3469 false success wearing a poll's clothes.
 * The peer therefore appears on the first real 2s poll tick.
 *
 * What the mock still does NOT model: a WRONG passphrase. There is no peer
 * transport in a single-process browser mock for a proof comparison to fail
 * against, so every input reaches the same success path. Rejection is
 * covered at the unit layer (`PairingDialog.test.tsx`, via the
 * `useSyncStore` error signal); what this file drives is the joiner's
 * confirm → honest wait → success resolution, end to end, including the
 * `PeerListItem` row that now really does render afterwards.
 */

async function openSyncSettings(page: import('@playwright/test').Page) {
  await waitForBoot(page)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator('header').getByText('Settings')).toBeVisible()
  await page.getByRole('tab', { name: /Sync.*Devices/i }).click()
  await expect(page.locator('[data-testid="settings-panel-sync"]')).toBeVisible()
}

/**
 * `beforeOpen` runs after the Sync settings panel is up but before the
 * dialog opens — the only safe window to install `page.clock`, since the
 * seed data's `today` must already be computed from real time (see the
 * expiry test) while every interval the dialog itself creates still has to
 * land on the fake clock.
 */
async function openPairNewDevice(
  page: import('@playwright/test').Page,
  beforeOpen?: () => Promise<void>,
) {
  await openSyncSettings(page)
  await beforeOpen?.()
  await page.getByRole('button', { name: /pair new device/i }).click()
  const dialog = activeDialog(page)
  await expect(dialog.getByText('Pair Device')).toBeVisible()
  return dialog
}

/**
 * #3463: the dialog now opens directly on the host path (this device's own
 * code) — no upfront chooser question. Pairing is still asymmetric — one
 * device shows a code, the other enters it — and the old symmetric UI (both
 * at once) is why two-device pairing could never succeed. That exclusivity
 * is now enforced by switching roles via this affordance instead of an
 * upfront choice: choosing "Have a code from the other device?" cancels the
 * host's own session and declares the joiner role. Every joiner-path test
 * therefore has to make that switch explicitly, exactly as a user does.
 */
async function chooseJoinerRole(dialog: ReturnType<typeof activeDialog>) {
  await dialog.getByRole('button', { name: /have a code from the other device/i }).click()
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
  // #3469 — this test used to end `await expect(activeDialog(page))
  // .toHaveCount(0)`: submit the passphrase, dialog closes. That assertion
  // WAS the bug. `confirm_pairing` only arms this device's local proof; it
  // cannot tell a correct passphrase from a typo, because the mismatch is
  // only discoverable later, on the wire. A dialog that closes there has
  // claimed an outcome it has no evidence for. The contract now is the
  // opposite: the dialog STAYS OPEN in a waiting state, and closes only when
  // a peer that was absent at confirm time actually shows up.
  test('entering a passphrase submits confirm_pairing and holds the honest waiting state until a peer actually appears', async ({
    page,
  }) => {
    // The fake clock makes "still waiting" an assertion about elapsed time
    // rather than a race: while it is frozen, the joiner's 2s
    // `list_peer_refs` poll cannot tick, so the only reads that can have
    // happened are the two the mock deliberately keeps peer-free.
    const dialog = await openPairNewDevice(page, () => page.clock.install())
    await chooseJoinerRole(dialog)
    // Install AFTER boot — `installIpcRecorder` wraps
    // `window.__TAURI_INTERNALS__.invoke`, which the mock only installs
    // once the app has navigated/booted (helpers.ts:584-600); calling it
    // pre-navigation is a silent no-op.
    await installIpcRecorder(page)

    // Mock's start_pairing always returns this passphrase.
    await fillPassphrase(dialog, ['alpha', 'bravo', 'charlie', 'delta'])
    await dialog.getByRole('button', { name: 'Pair', exact: true }).click()

    const calls = await getInvokeCalls(page, 'confirm_pairing')
    expect(calls.at(-1)?.['passphrase']).toBe('alpha bravo charlie delta')

    // The waiting state, not a success claim.
    const waiting = dialog.getByTestId('pairing-waiting-state')
    await expect(waiting).toBeVisible()
    await expect(waiting.getByText('Waiting for the other device…')).toBeVisible()

    // ...and it PERSISTS. Both of the joiner's pre-tick reads have already
    // resolved by now (the baseline snapshot and the poll's immediate
    // fetch — neither is timer-driven, so the frozen clock does not hold
    // them back), and neither produced a peer. Nothing further can happen
    // until time moves, so a dialog still open here is open on purpose.
    await expect(activeDialog(page)).toHaveCount(1)
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)

    // One poll interval (PAIRING_PEER_POLL_INTERVAL_MS = 2000 in
    // PairingDialog.tsx) later, the mock materializes the pinned peer on
    // the third read and the wait resolves — for the first time with actual
    // evidence behind it.
    await page.clock.runFor(2000)

    await expect(
      page.locator('[data-sonner-toast]').getByText('Device paired successfully'),
    ).toBeVisible()
    await expect(activeDialog(page)).toHaveCount(0)

    // The peer is real mock state now, not a toast: closing the dialog
    // re-runs DeviceManagement's `loadData` (DeviceManagement.tsx:225-231)
    // and the row renders in the Sync settings device list — the "peer
    // appears in the device list" assertion this file's header used to
    // record as structurally unreachable.
    // Scoped to the row's own name element: an unscoped text match also
    // hits the "Paired Devices (1)" section heading.
    await expect(page.locator('[data-testid="settings-panel-sync"] .device-peer-name')).toHaveText(
      'Paired Device',
    )
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
      await chooseJoinerRole(dialog)

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

      // Clear the injection and retry. #3463: this used to assert the
      // passphrase text `/alpha/i` became visible again, because retry re-ran
      // an `init()` that called `start_pairing` and re-displayed the generated
      // passphrase. That was the symmetric UI — a joiner has no generated
      // passphrase to display, and re-running `start_pairing` here is exactly
      // the role confusion the fix removes. The role-appropriate observable is
      // that the failure clears and the entry form is usable again.
      await page.evaluate(() => {
        ;(window as unknown as { __clearMockErrors?: () => void }).__clearMockErrors?.()
      })
      await retryBtn.click()
      await expect(errorBanner).toHaveCount(0)
      const wordInputs = dialog.locator('input[aria-label*="Passphrase word"]')
      await expect(wordInputs).toHaveCount(4)
      await expect(wordInputs.first()).toBeEnabled()
    })
  })

  test('pairing session expiry on the host path shows "Session expired" and offers retry', async ({
    page,
  }) => {
    // #3463: this test used to assert a countdown AND the passphrase word
    // inputs on one screen. That screen no longer exists, and its absence is
    // the fix: the countdown belongs to the host (it owns the session being
    // timed) and the word inputs belong to the joiner (it has no session), so
    // asserting both together was asserting the symmetric UI that made pairing
    // impossible. Rescoped to the host path, where the countdown actually lives
    // (`PairingQrDisplay`). The joiner has no local session to expire; what a
    // joiner experiences when the host's code lapses is a wire-level rejection,
    // not a local countdown, and is not covered here.
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
    // #3463: the dialog opens directly on the host path — no chooser click
    // needed before the countdown appears.
    await expect(dialog.locator('.pairing-countdown')).toContainText('5:00')

    // PAIRING_TIMEOUT_SECONDS is 300 (PairingDialog.tsx); run past it.
    // `runFor` (not `fastForward`) is required: the countdown decrements
    // via a 1000ms `setInterval` tick-by-tick, and `fastForward` only fires
    // a given due timer AT MOST ONCE (it "jumps" time, simulating a laptop
    // reopened later) -- under it the interval fires exactly once and the
    // countdown only drops by one second. `runFor` replays every due tick,
    // matching real elapsed time.
    await page.clock.runFor('05:01')

    await expect(dialog.locator('.pairing-expired').getByText('Session expired')).toBeVisible()
    await expect(dialog.locator('.pairing-retry-expired-btn')).toBeVisible()
  })

  test('Sync button with no paired devices opens NoPeersDialog and its CTA opens Sync settings', async ({
    page,
  }) => {
    await waitForBoot(page)

    // The `peerRefs` store starts empty on every fresh page and only ever
    // gains a row via `confirm_pairing` (see file header), which this test
    // never performs — so the sidebar Sync click guard (App.tsx:329-348)
    // still opens NoPeersDialog rather than silently syncing.
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

  // #3469 — this skip used to claim peer management was *structurally*
  // unreachable, because no mock handler could ever produce a peer row.
  // That is no longer the reason: `confirm_pairing` + three
  // `list_peer_refs` reads now produce a real row, and the pairing test
  // above asserts it renders in DeviceManagement. `delete_peer_ref` is
  // backed by the store too, so unpair is drivable here.
  //
  // Rename and manual address are NOT: `update_peer_name` and
  // `set_peer_address` remain no-op stubs that never touch `peerRefs`, so
  // the row's name/address can't change no matter what the UI submits.
  // Kept skipped as one unit rather than split, since the remaining gap is
  // a mock gap and not a coverage decision — all three are covered at the
  // unit layer (DeviceManagement.test.tsx:249/829, PeerListItem.test.tsx:155).
  test.skip('peer management (unpair / rename / manual address)', () => {
    // Rename/address are unobservable on the web+mock harness — see file header.
  })
})
