// ---------------------------------------------------------------------------
// The real Linux webview delivers a live camera track (#5386).
//
// This runner has no camera, so under `AGARIC_E2E_SANDBOX` the app turns on
// WebKitGTK's mock capture devices. It does not pin `allow_capture_permission`
// (src-tauri/src/lib.rs): under WebDriver, WebKit grants `getUserMedia` itself
// and never asks the app, so that handler's unit test is its only check. The
// scanner itself is `qr-scanner-camera.e2e.ts`.
//
// Globals (`browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { waitForAppReady } from './helpers'

describe('Agaric real-webview camera (#5386) @sync', () => {
  it('resolves getUserMedia({ video: true }) with a live video track', async () => {
    await waitForAppReady()

    const outcome = await browser.execute(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true })
        const states = stream.getVideoTracks().map((track) => track.readyState)
        for (const track of stream.getTracks()) track.stop()
        return { states }
      } catch (err) {
        // Not `error`: WebDriver reads a returned object with that key as a failed command.
        return { failure: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
      }
    })

    expect(outcome).toEqual({ states: ['live'] })
  })
})
