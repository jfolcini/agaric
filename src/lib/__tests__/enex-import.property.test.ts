/**
 * Property-based tests for the Evernote `.enex` importer (#2590).
 *
 * `parseEnex` accepts fully untrusted XML (a user's exported vault), so it is a
 * raw-input boundary. The example-based `enex-import.test.ts` pins specific
 * shapes; these fast-check properties assert the contract across a wide input
 * space: arbitrary input never yields a non-array or hangs (malformed XML must
 * fail with a clean `Error`), and any well-formed ENEX round-trips its note
 * count, titles, and tags.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parseEnex } from '../enex-import'

/** Build a well-formed ENEX document from XML-safe note fields. */
function buildEnex(notes: { title: string; tags: string[] }[]): string {
  const noteXml = notes
    .map((n) => {
      const tags = n.tags.map((t) => `<tag>${t}</tag>`).join('')
      // Fixed, valid ENML body — the properties under test are structural
      // (count/title/tags), not the ENML→Markdown conversion.
      const content = '<![CDATA[<en-note><p>body</p></en-note>]]>'
      return `<note><title>${n.title}</title><content>${content}</content>${tags}</note>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><en-export>${noteXml}</en-export>`
}

describe('parseEnex (property)', () => {
  it('on arbitrary input returns an array or throws a clean Error — never hangs or returns a non-array', () => {
    fc.assert(
      fc.property(fc.string(), (xml) => {
        try {
          const result = parseEnex(xml)
          expect(Array.isArray(result)).toBe(true)
        } catch (err) {
          // The only sanctioned failure mode is the explicit malformed-XML throw.
          expect(err).toBeInstanceOf(Error)
        }
      }),
      { numRuns: 500 },
    )
  })

  it('round-trips note count, titles, and tags for well-formed ENEX', () => {
    // Space-free, non-empty tokens so `parseEnex`'s `.trim()` on titles/tags is
    // the identity and no title folds to the Untitled placeholder.
    const arbTitle = fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/)
    const arbTag = fc.stringMatching(/^[a-zA-Z0-9]{1,10}$/)
    const arbNote = fc.record({
      title: arbTitle,
      tags: fc.array(arbTag, { maxLength: 4 }),
    })

    fc.assert(
      fc.property(fc.array(arbNote, { maxLength: 6 }), (notes) => {
        const parsed = parseEnex(buildEnex(notes))
        expect(parsed).toHaveLength(notes.length)
        parsed.forEach((p, i) => {
          expect(p.title).toBe(notes[i]?.title)
          expect(p.tags).toEqual(notes[i]?.tags)
        })
      }),
      { numRuns: 200 },
    )
  })
})
