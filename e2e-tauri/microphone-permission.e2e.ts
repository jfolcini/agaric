// ---------------------------------------------------------------------------
// The real Linux webview delivers a live microphone track (#5717).
//
// A voice note records through `getUserMedia({ audio: true })`. This runner has
// no microphone, so under `AGARIC_E2E_SANDBOX` the app turns on WebKitGTK's mock
// capture devices. Like its camera twin, `camera-permission.e2e.ts`, it cannot
// pin `allow_capture_permission`: under WebDriver, WebKit grants `getUserMedia`
// itself and never asks the app.
//
// Globals (`browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { waitForAppReady } from './helpers'

describe('Agaric real-webview microphone (#5717) @attachments', () => {
  it('resolves getUserMedia({ audio: true }) with a live audio track', async () => {
    await waitForAppReady()

    const outcome = await browser.execute(async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const states = stream.getAudioTracks().map((track) => track.readyState)
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
