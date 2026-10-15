// ---------------------------------------------------------------------------
// Unit tests for the pairing-QR reader the sync peer pairs through (#5365).
// VITEST, not WDIO: see visibility-probe.test.ts for why they live here.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

import { decodeQrSvg } from './sync-peer'

/** zxing's encoder, from the same build `decodeQrSvg` reads with. */
const zxing = createRequire(import.meta.url)('html5-qrcode/third_party/zxing-js.umd.js') as {
  QRCodeEncoder: {
    encode(
      text: string,
      level: unknown,
    ): { getMatrix(): { getWidth(): number; get(x: number, y: number): number } }
  }
  QRCodeDecoderErrorCorrectionLevel: { M: unknown }
}

/**
 * `text` as a QR drawn the way `qrcode::render::svg` draws one: 8 px modules,
 * a 4-module quiet zone, and one `M{left} {top}h8v8H{left}V{top}` square per
 * dark module (that crate's `draw_dark_rect`).
 */
function backendQrSvg(text: string): { viewBox: string; d: string } {
  const matrix = zxing.QRCodeEncoder.encode(
    text,
    zxing.QRCodeDecoderErrorCorrectionLevel.M,
  ).getMatrix()
  const modules = matrix.getWidth()
  const size = (modules + 8) * 8
  let d = ''
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (matrix.get(x, y) !== 1) continue
      const left = (x + 4) * 8
      const top = (y + 4) * 8
      d += `M${left} ${top}h8v8H${left}V${top}`
    }
  }
  return { viewBox: `0 0 ${size} ${size}`, d }
}

describe('decodeQrSvg', () => {
  it('reads back the payload of a QR drawn as the backend draws it', () => {
    const payload = JSON.stringify({
      v: 2,
      passphrase: 'acorn bucket candle dune',
      device_id: '0b7f6a62-1c8e-4c8a-9a51-2a3c1f0e9d11',
      endpoint_id: '3c'.repeat(32),
      addrs: ['10.1.0.5:45678'],
    })
    const { viewBox, d } = backendQrSvg(payload)

    expect(decodeQrSvg(viewBox, d)).toBe(payload)
  })

  it('names the failure when the drawing holds no QR code', () => {
    const { viewBox } = backendQrSvg('anything')

    expect(() => decodeQrSvg(viewBox, '')).toThrow('no QR code in the pairing SVG')
  })
})
