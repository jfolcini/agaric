// ---------------------------------------------------------------------------
// The camera, and pairing by scanning a QR code, on the real backend (#5739).
//
// The second device, `e2e_sync_peer`, hosts the pairing and the app joins it by
// scanning the host's QR. The runner has no camera, and WebKitGTK's mock
// capture devices show a fixed test pattern, so the spec swaps the page's
// `getUserMedia` for a canvas stream that draws the peer's QR. Everything after
// that is the app's own: html5-qrcode reads the frames, the dialog fills the
// passphrase from the scan, and the pairing runs over the address the QR names.
//
// The two tests before it show the camera itself in the real Linux webview,
// against WebKitGTK's mock capture devices, which the app turns on under
// `AGARIC_E2E_SANDBOX`: `getUserMedia` delivers a live track (#5386), and the
// scanner plays it (#5718). They run first because the scan test replaces the
// page's `getUserMedia` for the rest of the vault's session. Neither pins
// `allow_capture_permission` (src-tauri/src/lib.rs): under WebDriver, WebKit
// grants `getUserMedia` itself and never asks the app, so that handler's unit
// test is its only check. The Chromium twin of the scanner, which also
// measures the viewfinder, is `e2e/qr-scanner-camera.spec.ts`.
//
// Globals (`$`, `browser`, `expect`) come from @wdio/globals — see helpers.ts.
// ---------------------------------------------------------------------------

import { ACTION_TIMEOUT, waitForAppReady, waitForToast } from './helpers'
import { openSyncSettings, startSyncPeer } from './sync-peer'
import type { SyncPeer } from './sync-peer'

/**
 * Make the page's camera a canvas that shows the QR of backend SVG `svg`: the
 * backend draws a `0 0 w h` viewBox and one `M{left} {top}h{w}v{h}H{left}V{top}`
 * square per dark module.
 */
async function pointCameraAtQr(svg: string): Promise<void> {
  await browser.execute((markup: string) => {
    const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(markup)
    const modules = Number(viewBox?.[1])
    const side = 800
    const scale = Math.floor(side / modules)
    const offset = Math.floor((side - scale * modules) / 2)
    const canvas = document.createElement('canvas')
    canvas.width = side
    canvas.height = side
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('no 2d canvas')
    // Each repaint moves the QR a pixel, cycling through one module (the backend
    // draws 8 units per module): html5-qrcode samples the frame down to a few
    // pixels per module, and some payloads never decode from a frame that holds
    // still, which a hand-held camera never does.
    let jitter = 0
    const draw = () => {
      context.fillStyle = '#fff'
      context.fillRect(0, 0, side, side)
      context.fillStyle = '#000'
      const origin = offset + jitter
      for (const square of markup.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)H\d+V\d+/g)) {
        const [left = 0, top = 0, w = 0, h = 0] = square.slice(1).map(Number)
        context.fillRect(origin + left * scale, origin + top * scale, w * scale, h * scale)
      }
      jitter = (jitter + 1) % 8
    }
    // A canvas stream emits a frame only when the canvas changes.
    draw()
    setInterval(draw, 100)
    // On the prototype: WebKit can collect the `navigator.mediaDevices` wrapper
    // and hand the page a new one, which drops a property set on the old one.
    MediaDevices.prototype.getUserMedia = () => Promise.resolve(canvas.captureStream(10))
  }, svg)
}

/** Open the pairing dialog's QR scanner from the sync settings. */
async function openScanner(): Promise<void> {
  await openSyncSettings()
  for (const label of ['Pair new device', 'Have a code from the other device', 'Scan QR code']) {
    const button = $(`button*=${label}`)
    await button.waitForClickable({ timeout: ACTION_TIMEOUT })
    await button.click()
  }
}

describe('Agaric real-backend camera and pairing by QR scan (#5739) @sync', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it('resolves getUserMedia({ video: true }) with a live video track (#5386)', async () => {
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

  it('the QR scanner plays the camera in the viewfinder and shows no camera error (#5718)', async () => {
    // html5-qrcode asks `getUserMedia` for the scanner's `facingMode`, then
    // applies its square request (`aspectRatio`) to the track, so WebKitGTK has
    // to accept both and play the stream.
    await openScanner()
    // The scanner is a lazy chunk; until it mounts there is nothing to read.
    const viewport = $('[aria-label="QR code scanner viewport"]')
    await viewport.waitForExist({ timeout: ACTION_TIMEOUT })

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

    // A joiner's dialog shows no passphrase, so Escape closes it without asking.
    await browser.keys(['Escape'])
    await viewport.waitForExist({ reverse: true, timeout: ACTION_TIMEOUT })
  })

  it('scanning the other device\u2019s QR code pairs the two', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()
    const qr = await peer.hostPairing()
    await pointCameraAtQr(qr)

    await openScanner()
    // A scan fills the four words and flips back to typing, for the user to check.
    await waitForToast('QR code scanned')
    const pair = $('.pairing-pair-btn')
    await pair.waitForClickable({ timeout: ACTION_TIMEOUT })
    await pair.click()
    await waitForToast('Device paired successfully')

    // The peer holds the app as its peer: the pairing ran over the scanned address.
    const appId = await peer.waitJoined()
    expect(await peer.listPeers()).toEqual([appId])
    await $('.device-peer-item').waitForDisplayed({ timeout: ACTION_TIMEOUT })
  })
})
