// ---------------------------------------------------------------------------
// The real Linux webview grants the camera (#5386).
//
// WebKitGTK denies a `permission-request` nobody answers, so the pairing QR
// scanner's `getUserMedia` failed with `NotAllowedError` on Linux.
// `allow_camera_permission` (src-tauri/src/lib.rs) answers it. This runner has
// no camera, so under `AGARIC_E2E_SANDBOX` the app turns on WebKitGTK's mock
// capture devices; without the handler the same call rejects. The Chromium
// twin of the scanner flow is `e2e/qr-scanner-camera.spec.ts`, against the mock.
//
// Globals (`browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { waitForAppReady } from './helpers'

describe('Agaric real-webview camera permission (#5386)', () => {
  it('resolves getUserMedia({ video: true }) with a live video track', async () => {
    await waitForAppReady()

    const outcome = await browser.execute(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        const states = stream.getVideoTracks().map((track) => track.readyState)
        for (const track of stream.getTracks()) track.stop()
        return { states }
      } catch (err) {
        return { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
      }
    })

    expect(outcome).toEqual({ states: ['live'] })
  })
})
