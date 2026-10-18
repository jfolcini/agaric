/**
 * An Ogg Opus file writer (RFC 7845) for the `/voice` recorder on webviews
 * whose `MediaRecorder` cannot record (WebKitGTK, #5730): `AudioEncoder`
 * hands over raw Opus packets, and this wraps them in Ogg pages.
 *
 * Pages are written as packets arrive, so `byteLength` is the size of the file
 * so far, which the recorder's size cap reads.
 */

const BEGINNING_OF_STREAM = 0x02
const END_OF_STREAM = 0x04
/**
 * WebKitGTK's `<audio preload="metadata">` leaves the last page out of the
 * duration it reports, so pages stay short (200 ms of 20 ms packets) and the
 * last packet goes on a page of its own. It can also stop reading early, which
 * is why `AttachmentAudio` preloads `auto`.
 */
const PACKETS_PER_PAGE = 10
const MAX_SEGMENTS_PER_PAGE = 255
const STREAM_SERIAL = 0x5a6c

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let bit = 0; bit < 8; bit++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    table[i] = r >>> 0
  }
  return table
})()

/** Ogg's page checksum: CRC-32, polynomial 0x04c11db7, no reflection, initial value and final XOR 0. */
export function oggCrc32(bytes: Uint8Array): number {
  let crc = 0
  for (const byte of bytes)
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff] ?? 0)) >>> 0
  return crc
}

const SILK_FRAME_SAMPLES = [480, 960, 1920, 2880]
const HYBRID_FRAME_SAMPLES = [480, 960]
const CELT_FRAME_SAMPLES = [120, 240, 480, 960]

/**
 * The 48 kHz samples one Opus packet holds, read from its TOC byte
 * (RFC 6716 §3.1). WebKitGTK's `EncodedAudioChunk.duration` and `timestamp`
 * are wrong, so the granule position is counted from the packets themselves.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0] ?? 0
  const config = toc >> 3
  const frameSamples =
    config < 12
      ? SILK_FRAME_SAMPLES[config & 3]
      : config < 16
        ? HYBRID_FRAME_SAMPLES[config & 1]
        : CELT_FRAME_SAMPLES[config & 3]
  const code = toc & 3
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2
  return (frameSamples ?? 0) * frames
}

function segmentCount(packet: Uint8Array): number {
  return Math.floor(packet.length / 255) + 1
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('agaric')
  const tags = new Uint8Array(8 + 4 + vendor.length + 4)
  tags.set(new TextEncoder().encode('OpusTags'))
  new DataView(tags.buffer).setUint32(8, vendor.length, true)
  tags.set(vendor, 12)
  return tags
}

function oggPage(packets: Uint8Array[], granule: number, sequence: number, flags: number) {
  const lacing: number[] = []
  for (const packet of packets) {
    for (let left = packet.length; left >= 255; left -= 255) lacing.push(255)
    lacing.push(packet.length % 255)
  }
  const bodyLength = packets.reduce((sum, packet) => sum + packet.length, 0)
  const page = new Uint8Array(27 + lacing.length + bodyLength)
  const view = new DataView(page.buffer)
  page.set(new TextEncoder().encode('OggS'))
  page[5] = flags
  view.setBigUint64(6, BigInt(granule), true)
  view.setUint32(14, STREAM_SERIAL, true)
  view.setUint32(18, sequence, true)
  page[26] = lacing.length
  page.set(lacing, 27)
  let offset = 27 + lacing.length
  for (const packet of packets) {
    page.set(packet, offset)
    offset += packet.length
  }
  view.setUint32(22, oggCrc32(page), true)
  return page
}

export class OggOpusWriter {
  private readonly pages: Uint8Array<ArrayBuffer>[] = []
  private readonly onPage: Uint8Array[] = []
  private held: Uint8Array | null = null
  private granule = 0
  private sequence = 0
  private writtenBytes = 0

  /** `opusHead` is the encoder's `decoderConfig.description`, the stream's identification header. */
  constructor(opusHead: Uint8Array) {
    this.writePage([opusHead], BEGINNING_OF_STREAM)
    this.writePage([opusTags()], 0)
  }

  /** The file's size so far, counting the packets not yet on a page. */
  get byteLength(): number {
    const onPage = this.onPage.reduce((sum, packet) => sum + packet.length, 0)
    return this.writtenBytes + onPage + (this.held?.length ?? 0)
  }

  addPacket(packet: Uint8Array): void {
    // The newest packet waits: it may be the last, which goes on the end page alone.
    const previous = this.held
    this.held = packet
    if (previous) this.placeOnPage(previous)
  }

  /** The finished file. Nothing may be added after. */
  finish(): Blob {
    if (this.onPage.length > 0) this.writePage(this.onPage.splice(0), 0)
    if (this.held) this.granule += opusPacketSamples(this.held)
    this.writePage(this.held ? [this.held] : [], END_OF_STREAM)
    this.held = null
    return new Blob(this.pages, { type: 'audio/ogg' })
  }

  private placeOnPage(packet: Uint8Array): void {
    const segments = this.onPage.reduce((sum, p) => sum + segmentCount(p), 0)
    if (segments + segmentCount(packet) > MAX_SEGMENTS_PER_PAGE) {
      this.writePage(this.onPage.splice(0), 0)
    }
    this.onPage.push(packet)
    this.granule += opusPacketSamples(packet)
    if (this.onPage.length === PACKETS_PER_PAGE) this.writePage(this.onPage.splice(0), 0)
  }

  private writePage(packets: Uint8Array[], flags: number): void {
    const page = oggPage(packets, this.granule, this.sequence++, flags)
    this.pages.push(page)
    this.writtenBytes += page.length
  }
}
