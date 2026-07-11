/**
 * Property-based tests for the Joplin `.jex` importer (#2590).
 *
 * `parseJex` accepts fully untrusted bytes (a user's exported archive), driven
 * through a hand-rolled USTAR tar reader — a raw-input boundary. The
 * example-based `jex-import.test.ts` pins specific shapes; these fast-check
 * properties assert the contract across a wide input space: arbitrary bytes
 * never throw or hang (they degrade to zero notes), and any well-formed archive
 * round-trips its note count and titles.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parseJex } from '../jex-import'

const enc = new TextEncoder()

// --- Minimal USTAR tar builder (mirrors jex-import.test.ts) -----------------

function octalField(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, '0')}\0`
}

function buildTar(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const { name, data } of members) {
    const header = new Uint8Array(512)
    header.set(enc.encode(name).subarray(0, 100), 0)
    header.set(enc.encode('0000644\0'), 100) // mode
    header.set(enc.encode(octalField(data.length, 12)), 124) // size
    header[156] = 0x30 // typeflag '0' (regular file)
    header.set(enc.encode('ustar\0'), 257)
    header.set(enc.encode('00'), 263)
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0
    header.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data)
    blocks.push(padded)
  }
  blocks.push(new Uint8Array(512), new Uint8Array(512)) // end-of-archive
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const b of blocks) {
    out.set(b, off)
    off += b.length
  }
  return out
}

/** Serialize a Joplin note item: content, a blank line, then `key: value` meta. */
function noteItem(id: string, title: string): { name: string; data: Uint8Array } {
  const text = `${title}\n\nbody of ${title}\n\nid: ${id}\ntype_: 1\n`
  return { name: `${id}.md`, data: enc.encode(text) }
}

describe('parseJex (property)', () => {
  it('degrades gracefully on arbitrary bytes — never throws, always returns a result shape', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
        const result = parseJex(bytes)
        expect(Array.isArray(result.notes)).toBe(true)
        expect(typeof result.skipped).toBe('number')
      }),
      { numRuns: 500 },
    )
  })

  it('round-trips note count and titles for a well-formed archive', () => {
    // Space-free, non-empty titles so `parseJex`'s `.trim()` on the first line
    // is the identity and no note folds to the Untitled placeholder. Root-level
    // notes (empty parent_id) keep a bare, non-namespaced title.
    const arbTitle = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/)

    fc.assert(
      fc.property(fc.array(arbTitle, { maxLength: 8 }), (titles) => {
        // Assign a unique 32-char id per note by index (Joplin ids are 32 hex
        // chars; digits suffice and stay unique).
        const members = titles.map((title, i) => noteItem(String(i).padStart(32, '0'), title))
        const { notes, skipped } = parseJex(buildTar(members))

        expect(skipped).toBe(0)
        expect(notes).toHaveLength(titles.length)
        expect(notes.map((n) => n.title).toSorted()).toEqual(titles.toSorted())
      }),
      { numRuns: 200 },
    )
  })
})
