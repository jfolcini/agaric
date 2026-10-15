// ---------------------------------------------------------------------------
// The second device for the real-backend lane (#5365).
//
// `src-tauri/diagnostics/src/bin/e2e_sync_peer.rs` is a headless vault running
// the app's own sync daemon. `startSyncPeer` gives each spec one, on its own
// `mkdtemp` vault, and talks to it one JSON line at a time (the binary's
// `Command` and `Reply` are the protocol). `readPairingQr` reads the app's
// pairing QR the way that device's camera would: the QR is the one place the
// app says where it listens, so a peer can pair without mDNS.
//
// The e2e-tauri workflow builds the peer, and so does `wdio.conf.ts`'s local
// `onPrepare`: `cd src-tauri && cargo build -p agaric-diagnostics --bin e2e_sync_peer`.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'

import { ACTION_TIMEOUT } from './helpers'

/**
 * The part of the zxing build html5-qrcode ships (the app's own QR scanner)
 * that reads a QR from pixels.
 */
interface ZxingReader {
  QRCodeReader: new () => {
    decode(image: unknown, hints: Map<number, boolean>): { getText(): string }
  }
  BinaryBitmap: new (binarizer: unknown) => unknown
  HybridBinarizer: new (source: unknown) => unknown
  RGBLuminanceSource: new (luminances: Uint8ClampedArray, width: number, height: number) => unknown
  DecodeHintType: { PURE_BARCODE: number }
}

const zxing = createRequire(import.meta.url)(
  'html5-qrcode/third_party/zxing-js.umd.js',
) as ZxingReader

/**
 * The text of a QR as the backend draws it (`pairing::generate_qr_svg`, the
 * `qrcode` crate): a `0 0 w h` viewBox and one path made of a
 * `M{left} {top}h{w}v{h}H{left}V{top}` square per dark module.
 */
export function decodeQrSvg(viewBox: string, d: string): string {
  const [width, height] = /^0 0 (\d+) (\d+)$/.exec(viewBox)?.slice(1).map(Number) ?? []
  if (width === undefined || height === undefined) {
    throw new Error(`not a QR viewBox: ${JSON.stringify(viewBox)}`)
  }
  const pixels = new Uint8ClampedArray(width * height).fill(255)
  for (const square of d.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)H\d+V\d+/g)) {
    const [left = 0, top = 0, w = 0, h = 0] = square.slice(1).map(Number)
    for (let y = top; y < top + h; y++) pixels.fill(0, y * width + left, y * width + left + w)
  }
  const image = new zxing.BinaryBitmap(
    new zxing.HybridBinarizer(new zxing.RGBLuminanceSource(pixels, width, height)),
  )
  try {
    const hints = new Map([[zxing.DecodeHintType.PURE_BARCODE, true]])
    return new zxing.QRCodeReader().decode(image, hints).getText()
  } catch (error) {
    throw new Error(`no QR code in the pairing SVG: ${String(error)}`)
  }
}

/** A v2 pairing QR (`pairing::pairing_qr_payload`): the code, and where to dial its host. */
export interface PairingQr {
  passphrase: string
  device_id: string
  endpoint_id: string
  addrs: string[]
}

/** The open pairing dialog's QR (`[data-testid="pairing-qr-code"]`), decoded. */
export async function readPairingQr(): Promise<PairingQr> {
  await $('[data-testid="pairing-qr-code"] svg path').waitForExist({ timeout: ACTION_TIMEOUT })
  const svg = await browser.execute(() => {
    const element = document.querySelector('[data-testid="pairing-qr-code"] svg')
    return {
      viewBox: element?.getAttribute('viewBox') ?? '',
      d: element?.querySelector('path')?.getAttribute('d') ?? '',
    }
  })
  const text = decodeQrSvg(svg.viewBox, svg.d)
  const qr = JSON.parse(text) as Partial<PairingQr>
  // A v1 code: the app's endpoint had not bound by the time it drew the QR.
  if (qr.addrs === undefined) throw new Error(`the pairing QR names no address: ${text}`)
  return qr as PairingQr
}

type Command =
  | ({ cmd: 'pair' } & PairingQr)
  | { cmd: 'sync' }
  | { cmd: 'get_block'; id: string }
  | { cmd: 'create_block'; parent_id: string; content: string }
  | { cmd: 'set_property'; id: string; key: string; value: string }
  | { cmd: 'move_block'; id: string; parent_id: string; index: number }
  | { cmd: 'get_property'; id: string; key: string }
  | { cmd: 'wait_pulled' }

type Reply =
  | { reply: 'paired'; device_id: string; address: string }
  | { reply: 'synced' }
  | { reply: 'block'; id: string; parent_id: string | null; content: string }
  | { reply: 'created'; id: string }
  | { reply: 'property_set' }
  | { reply: 'moved' }
  | { reply: 'property'; value_text: string | null }
  | { reply: 'pulled' }
  | { reply: 'error'; message: string }

/** A block as the peer's vault holds it. */
export interface PeerBlock {
  id: string
  parentId: string | null
  content: string
}

export interface SyncPeer {
  /** Join the app's pairing; resolves once the peer holds the app as its peer. */
  pair(qr: PairingQr): Promise<{ deviceId: string; address: string }>
  /** Pull from the app now; resolves once the pull has landed in the peer's vault. */
  sync(): Promise<void>
  getBlock(id: string): Promise<PeerBlock>
  /** Write a content block under `parentId`; resolves to its id. */
  createBlock(parentId: string, content: string): Promise<string>
  /** Set text property `key` on block `id`. */
  setProperty(id: string, key: string, value: string): Promise<void>
  /** Move block `id` under `parentId`, to 0-based sibling slot `index`. */
  moveBlock(id: string, parentId: string, index: number): Promise<void>
  /** Text property `key` of block `id`; null when the block holds none. */
  getProperty(id: string, key: string): Promise<string | null>
  /** Resolves once the app has pulled since the peer's last write. */
  waitPulled(): Promise<void>
  /** End the peer and delete its vault. */
  stop(): Promise<void>
}

export async function startSyncPeer(): Promise<SyncPeer> {
  const binary = path.resolve(
    import.meta.dirname,
    '..',
    'src-tauri',
    'target',
    'debug',
    'e2e_sync_peer',
  )
  const vault = mkdtempSync(path.join(os.tmpdir(), 'agaric-wdio-peer-'))
  const child = spawn(binary, [vault], { stdio: ['pipe', 'pipe', 'inherit'] })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (error) => {
      reject(new Error(`cannot start the sync peer ${binary}: ${error.message}`))
    })
  })
  // A write to a peer that died fails with EPIPE; `request` then reports the exit.
  child.stdin.on('error', (error) => {
    console.warn(`sync peer stdin: ${error.message}`)
  })
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()

  async function request<K extends Reply['reply']>(
    command: Command,
    expected: K,
  ): Promise<Extract<Reply, { reply: K }>> {
    child.stdin.write(`${JSON.stringify(command)}\n`)
    const line = await lines.next()
    if (line.done === true) {
      throw new Error(
        `the sync peer exited (${String(child.exitCode)}) before answering ${command.cmd}`,
      )
    }
    const reply = JSON.parse(line.value) as Reply
    if (reply.reply !== expected) throw new Error(`sync peer ${command.cmd}: ${line.value}`)
    return reply as Extract<Reply, { reply: K }>
  }

  return {
    pair: async (qr) => {
      const paired = await request({ cmd: 'pair', ...qr }, 'paired')
      return { deviceId: paired.device_id, address: paired.address }
    },
    sync: async () => {
      await request({ cmd: 'sync' }, 'synced')
    },
    getBlock: async (id) => {
      const block = await request({ cmd: 'get_block', id }, 'block')
      return { id: block.id, parentId: block.parent_id, content: block.content }
    },
    createBlock: async (parentId, content) =>
      (await request({ cmd: 'create_block', parent_id: parentId, content }, 'created')).id,
    setProperty: async (id, key, value) => {
      await request({ cmd: 'set_property', id, key, value }, 'property_set')
    },
    moveBlock: async (id, parentId, index) => {
      await request({ cmd: 'move_block', id, parent_id: parentId, index }, 'moved')
    },
    getProperty: async (id, key) =>
      (await request({ cmd: 'get_property', id, key }, 'property')).value_text,
    waitPulled: async () => {
      await request({ cmd: 'wait_pulled' }, 'pulled')
    },
    stop: async () => {
      // The end of stdin is the peer's shutdown.
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit')
        child.stdin.end()
        await exited
      }
      rmSync(vault, { recursive: true, force: true })
    },
  }
}
