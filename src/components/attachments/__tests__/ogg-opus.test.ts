/**
 * The Ogg Opus writer (#5730), read back with an independent page parser.
 * Whether a real decoder plays the file is pinned by `e2e/voice-note-record.spec.ts`
 * (Chromium) and `e2e-tauri/voice-note-record.e2e.ts` (WebKitGTK).
 */

import { describe, expect, it } from 'vitest'

import { OggOpusWriter, oggCrc32, opusPacketSamples } from '@/components/attachments/ogg-opus'

interface Page {
  flags: number
  granule: bigint
  serial: number
  sequence: number
  lacing: number[]
  packets: Uint8Array[]
  bytes: Uint8Array
}

function parsePages(file: Uint8Array): Page[] {
  const pages: Page[] = []
  let offset = 0
  while (offset < file.length) {
    const view = new DataView(file.buffer, file.byteOffset + offset)
    expect(new TextDecoder().decode(file.subarray(offset, offset + 4))).toBe('OggS')
    const segments = file[offset + 26] ?? 0
    const lacing = [...file.subarray(offset + 27, offset + 27 + segments)]
    const packets: Uint8Array[] = []
    let body = offset + 27 + segments
    let length = 0
    for (const value of lacing) {
      length += value
      if (value < 255) {
        packets.push(file.slice(body, body + length))
        body += length
        length = 0
      }
    }
    pages.push({
      flags: file[offset + 5] ?? -1,
      granule: view.getBigUint64(6, true),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      lacing,
      packets,
      bytes: file.slice(offset, body),
    })
    offset = body
  }
  return pages
}

async function written(writer: OggOpusWriter): Promise<{ blob: Blob; pages: Page[] }> {
  const blob = writer.finish()
  return { blob, pages: parsePages(new Uint8Array(await blob.arrayBuffer())) }
}

/** A 19-byte OpusHead: version 1, mono, pre-skip 312, 44.1 kHz input. */
const OPUS_HEAD = new Uint8Array([
  ...new TextEncoder().encode('OpusHead'),
  1,
  1,
  0x38,
  0x01,
  0x44,
  0xac,
  0,
  0,
  0,
  0,
  0,
])

/** TOC byte for CELT-only 20 ms frames (config 19), one frame per packet. */
const CELT_20MS = 19 << 3

function packet(toc: number, length: number, fill = 7): Uint8Array {
  const bytes = new Uint8Array(length).fill(fill)
  bytes[0] = toc
  return bytes
}

function writerWith(packets: Uint8Array[]): OggOpusWriter {
  const writer = new OggOpusWriter(OPUS_HEAD)
  for (const p of packets) writer.addPacket(p)
  return writer
}

describe('oggCrc32', () => {
  it('matches the CRC-32 check value for "123456789" with Ogg\'s parameters', () => {
    expect(oggCrc32(new TextEncoder().encode('123456789'))).toBe(0x89a1897f)
  })

  it('matches the checksum GStreamer oggmux stored on a real page', () => {
    const page = Uint8Array.from(
      '4f67675300020000000000000000cf4b5271000000003a86651001134f707573486561640101380180bb0000000000'
        .match(/../g)
        ?.map((byte) => Number.parseInt(byte, 16)) ?? [],
    )
    page.fill(0, 22, 26)
    expect(oggCrc32(page)).toBe(0x1065863a)
  })

  it('stamps every written page with its own checksum', async () => {
    const { pages } = await written(writerWith([packet(CELT_20MS, 80), packet(CELT_20MS, 300)]))
    for (const page of pages) {
      const stored = new DataView(page.bytes.buffer).getUint32(22, true)
      const zeroed = page.bytes.slice()
      zeroed.fill(0, 22, 26)
      expect(oggCrc32(zeroed)).toBe(stored)
    }
  })
})

describe('opusPacketSamples', () => {
  it.each([
    ['SILK 10 ms', 0 << 3, 480],
    ['SILK 20 ms', 1 << 3, 960],
    ['SILK 40 ms', 2 << 3, 1920],
    ['SILK 60 ms', 3 << 3, 2880],
    ['hybrid 10 ms', 12 << 3, 480],
    ['hybrid 20 ms', 13 << 3, 960],
    ['CELT 2.5 ms', 16 << 3, 120],
    ['CELT 5 ms', 17 << 3, 240],
    ['CELT 10 ms', 18 << 3, 480],
    ['CELT 20 ms', 19 << 3, 960],
    ['CELT 20 ms, wideband stereo flag', (31 << 3) | 0b100, 960],
  ])('counts one frame of %s', (_name, toc, samples) => {
    expect(opusPacketSamples(new Uint8Array([toc, 0]))).toBe(samples)
  })

  it('counts two frames for codes 1 and 2', () => {
    expect(opusPacketSamples(new Uint8Array([CELT_20MS | 1, 0]))).toBe(1920)
    expect(opusPacketSamples(new Uint8Array([(1 << 3) | 2, 0]))).toBe(1920)
  })

  it('reads the frame count of a code 3 packet from its second byte', () => {
    // M = 3 in the low six bits; the VBR and padding flags above them do not count.
    expect(opusPacketSamples(new Uint8Array([(18 << 3) | 3, 0b1100_0011]))).toBe(1440)
  })
})

describe('OggOpusWriter', () => {
  it('opens with the OpusHead page, then the OpusTags page', async () => {
    const { pages } = await written(writerWith([packet(CELT_20MS, 50)]))
    const [head, tags] = pages

    expect(head?.packets).toEqual([OPUS_HEAD])
    expect(head).toMatchObject({ flags: 0x02, granule: 0n, sequence: 0 })

    const vendor = new TextEncoder().encode('agaric')
    expect(tags?.packets).toEqual([
      new Uint8Array([
        ...new TextEncoder().encode('OpusTags'),
        vendor.length,
        0,
        0,
        0,
        ...vendor,
        0,
        0,
        0,
        0,
      ]),
    ])
    expect(tags).toMatchObject({ flags: 0, granule: 0n, sequence: 1 })
  })

  it('pages ten packets at a time and puts the last packet alone on the end page', async () => {
    const packets = Array.from({ length: 25 }, (_, i) => packet(CELT_20MS, 60, i))
    const { pages } = await written(writerWith(packets))
    const audio = pages.slice(2)

    expect(audio.map((page) => page.packets.length)).toEqual([10, 10, 4, 1])
    expect(audio.flatMap((page) => page.packets)).toEqual(packets)
    expect(audio.at(-1)?.packets).toEqual([packets[24]])
  })

  it('sets the beginning flag on the first page, the end flag on the last, and never continuation', async () => {
    const { pages } = await written(
      writerWith(Array.from({ length: 12 }, () => packet(CELT_20MS, 600))),
    )

    expect(pages.map((page) => page.flags)).toEqual([0x02, 0, 0, 0, 0x04])
    expect(pages.map((page) => page.sequence)).toEqual([0, 1, 2, 3, 4])
    expect(new Set(pages.map((page) => page.serial)).size).toBe(1)
  })

  it('sets each granule position to the samples counted from the TOC bytes so far', async () => {
    const packets = [
      ...Array.from({ length: 10 }, () => packet(CELT_20MS, 40)),
      packet(3 << 3, 40), // SILK 60 ms
      packet(CELT_20MS | 1, 40), // two 20 ms frames
      packet(CELT_20MS, 40),
    ]
    const { pages } = await written(writerWith(packets))

    expect(pages.map((page) => page.granule)).toEqual([
      0n,
      0n,
      9_600n,
      9_600n + 2_880n + 1_920n,
      9_600n + 2_880n + 1_920n + 960n,
    ])
  })

  it('laces a packet of 255 bytes or more in 255-byte segments', async () => {
    const long = packet(CELT_20MS, 510)
    const { pages } = await written(
      writerWith([packet(CELT_20MS, 300), long, packet(CELT_20MS, 5)]),
    )

    expect(pages[2]?.lacing).toEqual([255, 45, 255, 255, 0])
    expect(pages[2]?.packets[1]).toEqual(long)
  })

  it('starts a new page before one would exceed 255 segments', async () => {
    // 28 segments each: nine fit on a page, a tenth would not.
    const packets = Array.from({ length: 12 }, () => packet(CELT_20MS, 7_000))
    const { pages } = await written(writerWith(packets))

    expect(pages.slice(2).map((page) => page.packets.length)).toEqual([9, 2, 1])
    for (const page of pages) expect(page.lacing.length).toBeLessThanOrEqual(255)
  })

  it('counts every byte so far, paged or not, for the size cap', async () => {
    const writer = new OggOpusWriter(OPUS_HEAD)
    // OpusHead page 27 + 1 + 19, OpusTags page 27 + 1 + 22.
    expect(writer.byteLength).toBe(97)
    for (let i = 0; i < 10; i++) writer.addPacket(packet(CELT_20MS, 100))
    // Nine packets waiting for their page, and the newest held back.
    expect(writer.byteLength).toBe(97 + 900 + 100)

    const { blob } = await written(writer)
    // Finishing adds only the two pages' headers: 27 + 9 and 27 + 1.
    expect(blob.size).toBe(97 + 936 + 128)
    expect(blob.type).toBe('audio/ogg')
  })

  it('ends a recording with no audio on an empty end page', async () => {
    const { pages } = await written(new OggOpusWriter(OPUS_HEAD))

    expect(pages).toHaveLength(3)
    expect(pages[2]).toMatchObject({ flags: 0x04, granule: 0n, lacing: [], packets: [] })
  })
})
