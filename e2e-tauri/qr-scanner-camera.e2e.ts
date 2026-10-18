// ---------------------------------------------------------------------------
// The pairing QR scanner shows the camera in the real Linux webview (#5718).
//
// html5-qrcode asks `getUserMedia` for the scanner's `facingMode`, then applies
// its square request (`aspectRatio`) to the track, so WebKitGTK has to accept
// both and play the stream. This runner has no camera, so under
// `AGARIC_E2E_SANDBOX` the app turns on WebKitGTK's mock capture devices. The
// Chromium twin, which also measures the viewfinder, is
// `e2e/qr-scanner-camera.spec.ts`.
//
// Globals (`browser`, `$`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { ACTION_TIMEOUT, waitForAppReady } from './helpers'
import { openSyncSettings } from './sync-peer'

describe('Agaric real-webview QR scanner (#5718) @sync', () => {
  it('plays the camera in the viewfinder and shows no camera error', async () => {
    await waitForAppReady()
    await openSyncSettings()
    // Choosing to scan starts the camera.
    for (const label of ['Pair new device', 'Have a code from the other device', 'Scan QR code']) {
      const button = $(`button*=${label}`)
      await button.waitForClickable({ timeout: ACTION_TIMEOUT })
      await button.click()
    }
    // The scanner is a lazy chunk; until it mounts there is nothing to read.
    await $('[aria-label="QR code scanner viewport"]').waitForExist({ timeout: ACTION_TIMEOUT })

    // Not `error`: WebDriver reads a returned object with that key as a failed command.
    const readScanner = () =>
      browser.execute(() => {
        const viewfinder = document.querySelector('[aria-label="QR code scanner viewport"]')
        const video = viewfinder?.querySelector('video')
        return {
          playing: Boolean(video && !video.paused && video.videoWidth > 0),
          // A scanner that crashed takes its viewfinder with it.
          message:
            viewfinder?.querySelector('[aria-live="assertive"]')?.textContent ?? 'no viewfinder',
        }
      })
    await browser.waitUntil(
      async () => {
        const scanner = await readScanner()
        return scanner.playing || scanner.message !== ''
      },
      { timeout: ACTION_TIMEOUT, timeoutMsg: 'the scanner neither played the camera nor failed' },
    )

    expect(await readScanner()).toEqual({ playing: true, message: '' })
  })
})
