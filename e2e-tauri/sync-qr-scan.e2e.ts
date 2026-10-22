// ---------------------------------------------------------------------------
// Pairing by scanning a QR code, on the real backend (#5739).
//
// The second device, `e2e_sync_peer`, hosts the pairing and the app joins it by
// scanning the host's QR. The runner has no camera, and WebKitGTK's mock
// capture devices show a fixed test pattern, so the spec swaps the page's
// `getUserMedia` for a canvas stream that draws the peer's QR. Everything after
// that is the app's own: html5-qrcode reads the frames, the dialog fills the
// passphrase from the scan, and the pairing runs over the address the QR names.
// `qr-scanner-camera.e2e.ts` shows the scanner against the mock devices.
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

describe('Agaric real-backend pairing by QR scan (#5739) @sync', () => {
  let peer: SyncPeer | undefined

  before(async () => {
    peer = await startSyncPeer()
  })

  after(async () => {
    await peer?.stop()
  })

  it('scanning the other device\u2019s QR code pairs the two', async () => {
    if (peer === undefined) throw new Error('the sync peer never started')
    await waitForAppReady()
    const qr = await peer.hostPairing()
    await pointCameraAtQr(qr)

    await openSyncSettings()
    for (const label of ['Pair new device', 'Have a code from the other device', 'Scan QR code']) {
      const button = $(`button*=${label}`)
      await button.waitForClickable({ timeout: ACTION_TIMEOUT })
      await button.click()
    }
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
