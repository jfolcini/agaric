// ---------------------------------------------------------------------------
// The second device for the real-backend lane (#5365).
//
// `src-tauri/diagnostics/src/bin/e2e_sync_peer.rs` is a headless vault running
// the app's own sync daemon. `startSyncPeer` gives each spec one, on its own
// `mkdtemp` vault, and talks to it one JSON line at a time (the binary's
// `Command` and `Reply` are the protocol). `readPairingQr` reads the app's
// pairing QR the way that device's camera would: the QR is the one place the
// app says where it listens, so a peer can pair without mDNS. The app's side of
// the pairing (Settings › Sync & devices) is here too, for the specs that pair.
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

import { ACTION_TIMEOUT, NAV_TIMEOUT, navigateTo, typeInputVerified, waitForToast } from './helpers'

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

/** Settings › Sync & devices. */
export async function openSyncSettings(): Promise<void> {
  await navigateTo('Settings')
  const tab = $('#settings-tab-sync')
  await tab.waitForClickable({ timeout: NAV_TIMEOUT })
  await tab.click()
  await $('[data-testid="settings-panel-sync"]').waitForDisplayed({ timeout: NAV_TIMEOUT })
}

/** Open the pairing dialog from the sync settings; resolves to the passphrase it shows. */
export async function openPairing(): Promise<string> {
  const pairButton = $('button*=Pair new device')
  await pairButton.waitForClickable({ timeout: ACTION_TIMEOUT })
  await pairButton.click()
  await $('[data-testid="pairing-qr-code"] svg path').waitForExist({ timeout: ACTION_TIMEOUT })
  return $('.pairing-passphrase').getText()
}

/** The device list's row for a peer that sent no name, so shows its id. */
export function peerRow(deviceId: string) {
  return $(`//div[contains(@class, "device-peer-item")][contains(., "${deviceId.slice(0, 12)}")]`)
}

/**
 * Type the peer's address into the device list, as a user without mDNS would.
 * Paired by the peer's dial, the app holds no address to dial it back, and a
 * session is a pull by the device that dials (#610).
 */
export async function setPeerAddress(deviceId: string, address: string): Promise<void> {
  await openSyncSettings()
  const editAddress = peerRow(deviceId).$('button[aria-label^="Edit address for"]')
  await editAddress.waitForClickable({ timeout: NAV_TIMEOUT })
  await editAddress.click()
  await typeInputVerified('input[aria-label="Address (host:port)"]', address)
  const save = $('[role="dialog"]').$('button=Save')
  await save.waitForClickable({ timeout: ACTION_TIMEOUT })
  await save.click()
  await waitForToast('Address updated')
}

type Command =
  | ({ cmd: 'pair' } & PairingQr)
  | { cmd: 'sync' }
  | { cmd: 'sync_refused' }
  | { cmd: 'get_block'; id: string }
  | { cmd: 'create_block'; parent_id: string; content: string }
  | { cmd: 'create_in_space'; block_type: 'page' | 'tag'; content: string; space_id?: string }
  | { cmd: 'create_space'; name: string }
  | { cmd: 'move_to_space'; id: string; space_id: string }
  | { cmd: 'edit_block'; id: string; content: string }
  | { cmd: 'set_property'; id: string; key: string; value: string }
  | { cmd: 'set_todo_state'; id: string; state: string }
  | { cmd: 'set_due_date'; id: string; date: string }
  | { cmd: 'add_tag'; id: string; tag_id: string }
  | { cmd: 'move_block'; id: string; parent_id: string; index: number }
  | { cmd: 'get_property'; id: string; key: string }
  | { cmd: 'add_attachment'; id: string; filename: string; mime_type: string; bytes: number[] }
  | { cmd: 'list_attachments'; id: string }
  | { cmd: 'read_attachment'; id: string }
  | { cmd: 'wait_pulled' }
  | { cmd: 'list_peers' }

type Reply =
  | { reply: 'paired'; device_id: string; address: string }
  | { reply: 'synced' }
  | { reply: 'refused'; message: string }
  | { reply: 'block'; id: string; parent_id: string | null; content: string }
  | { reply: 'created'; id: string }
  | { reply: 'edited' }
  | { reply: 'property_set' }
  | { reply: 'tagged' }
  | { reply: 'moved' }
  | { reply: 'property'; value_text: string | null }
  | { reply: 'pulled' }
  | { reply: 'peers'; peer_ids: string[] }
  | { reply: 'attachments'; attachments: PeerAttachment[] }
  | { reply: 'bytes'; bytes: number[] }
  | { reply: 'error'; message: string }

/** A block as the peer's vault holds it. */
export interface PeerBlock {
  id: string
  parentId: string | null
  content: string
}

/** An attachment row as the peer's vault holds it. */
export interface PeerAttachment {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
}

export interface SyncPeer {
  /** Join the app's pairing; resolves once the peer holds the app as its peer. */
  pair(qr: PairingQr): Promise<{ deviceId: string; address: string }>
  /** Pull from the app now; resolves once the pull has landed in the peer's vault. */
  sync(): Promise<void>
  /** Pull from the app now; resolves to the app's words when it refuses the pull. */
  syncRefused(): Promise<string>
  getBlock(id: string): Promise<PeerBlock>
  /** Write a content block under `parentId`; resolves to its id. */
  createBlock(parentId: string, content: string): Promise<string>
  /**
   * Write a page or tag in space `spaceId`, or in the Personal space, the one a
   * fresh vault opens on; resolves to its id.
   */
  createInSpace(blockType: 'page' | 'tag', content: string, spaceId?: string): Promise<string>
  /** Create a space named `name`; resolves to its id. */
  createSpace(name: string): Promise<string>
  /** Move page `id` and its blocks to space `spaceId`. */
  moveToSpace(id: string, spaceId: string): Promise<void>
  /** Replace the whole text of block `id` with `content`. */
  editBlock(id: string, content: string): Promise<void>
  /** Set text property `key` on block `id`. */
  setProperty(id: string, key: string, value: string): Promise<void>
  /** Set the task state (`TODO`, `DONE`, …) of block `id`. */
  setTodoState(id: string, state: string): Promise<void>
  /** Set the due date (`YYYY-MM-DD`) of block `id`. */
  setDueDate(id: string, date: string): Promise<void>
  /** Tag block `id` with tag block `tagId`. */
  addTag(id: string, tagId: string): Promise<void>
  /** Move block `id` under `parentId`, to 0-based sibling slot `index`. */
  moveBlock(id: string, parentId: string, index: number): Promise<void>
  /** Text property `key` of block `id`; null when the block holds none. */
  getProperty(id: string, key: string): Promise<string | null>
  /** Attach `bytes` to block `id` as `filename`; resolves to the attachment's id. */
  addAttachment(id: string, filename: string, mimeType: string, bytes: Buffer): Promise<string>
  /** The attachment rows of block `id`. */
  listAttachments(id: string): Promise<PeerAttachment[]>
  /** The bytes of attachment `id` on the peer's disk; rejects while the file is missing. */
  readAttachment(id: string): Promise<Buffer>
  /** Resolves once the app has pulled since the peer's last write. */
  waitPulled(): Promise<void>
  /** The device ids the peer holds a pairing with. */
  listPeers(): Promise<string[]>
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
    syncRefused: async () => (await request({ cmd: 'sync_refused' }, 'refused')).message,
    getBlock: async (id) => {
      const block = await request({ cmd: 'get_block', id }, 'block')
      return { id: block.id, parentId: block.parent_id, content: block.content }
    },
    createBlock: async (parentId, content) =>
      (await request({ cmd: 'create_block', parent_id: parentId, content }, 'created')).id,
    createInSpace: async (blockType, content, spaceId) =>
      (
        await request(
          {
            cmd: 'create_in_space',
            block_type: blockType,
            content,
            ...(spaceId === undefined ? {} : { space_id: spaceId }),
          },
          'created',
        )
      ).id,
    createSpace: async (name) => (await request({ cmd: 'create_space', name }, 'created')).id,
    moveToSpace: async (id, spaceId) => {
      await request({ cmd: 'move_to_space', id, space_id: spaceId }, 'moved')
    },
    editBlock: async (id, content) => {
      await request({ cmd: 'edit_block', id, content }, 'edited')
    },
    setProperty: async (id, key, value) => {
      await request({ cmd: 'set_property', id, key, value }, 'property_set')
    },
    setTodoState: async (id, state) => {
      await request({ cmd: 'set_todo_state', id, state }, 'property_set')
    },
    setDueDate: async (id, date) => {
      await request({ cmd: 'set_due_date', id, date }, 'property_set')
    },
    addTag: async (id, tagId) => {
      await request({ cmd: 'add_tag', id, tag_id: tagId }, 'tagged')
    },
    moveBlock: async (id, parentId, index) => {
      await request({ cmd: 'move_block', id, parent_id: parentId, index }, 'moved')
    },
    getProperty: async (id, key) =>
      (await request({ cmd: 'get_property', id, key }, 'property')).value_text,
    addAttachment: async (id, filename, mimeType, bytes) =>
      (
        await request(
          { cmd: 'add_attachment', id, filename, mime_type: mimeType, bytes: [...bytes] },
          'created',
        )
      ).id,
    listAttachments: async (id) =>
      (await request({ cmd: 'list_attachments', id }, 'attachments')).attachments,
    readAttachment: async (id) =>
      Buffer.from((await request({ cmd: 'read_attachment', id }, 'bytes')).bytes),
    waitPulled: async () => {
      await request({ cmd: 'wait_pulled' }, 'pulled')
    },
    listPeers: async () => (await request({ cmd: 'list_peers' }, 'peers')).peer_ids,
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
