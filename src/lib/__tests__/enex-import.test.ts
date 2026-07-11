/**
 * Tests for the frontend-only Evernote `.enex` importer (#1282).
 *
 * Covers: title/tags/date extraction, ENML→Markdown conversion (headings,
 * lists, bold, links, `<pre>`), `<en-todo>` → task markers, multi-word tag →
 * `#[[…]]`, malformed XML throwing, multiple notes, empty-title placeholder,
 * timestamp epoch parsing (incl. null), and `<resource>`/`<en-media>`
 * attachment ingestion (#2513): base64 decode + MD5 hash-match + `en-media` →
 * `![](path)` rewrite, dangling-hash graceful fallback, and orphan resources.
 */

import { describe, expect, it } from 'vitest'

import {
  type EnexNote,
  enexNoteToMarkdown,
  parseEnex,
  sanitizeNoteTitleToFilename,
  UNTITLED_PLACEHOLDER,
} from '../enex-import'

/** Index into a parsed-note array with a runtime guard (no non-null assertions). */
function at(notes: EnexNote[], index = 0): EnexNote {
  const note = notes[index]
  if (note === undefined) throw new Error(`expected a note at index ${index}, got ${notes.length}`)
  return note
}

/** Wrap an ENML body in a CDATA `<content>` payload. */
function content(enml: string): string {
  const doctype = '<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">'
  return `<![CDATA[<?xml version="1.0" encoding="UTF-8"?>${doctype}<en-note>${enml}</en-note>]]>`
}

/** Build a full ENEX document from raw `<note>` XML fragments. */
function enex(...notes: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><en-export>${notes.join('')}</en-export>`
}

describe('parseEnex', () => {
  it('extracts title, tags, and timestamps', () => {
    const xml = enex(
      `<note>
        <title>My Note</title>
        <content>${content('<p>Body</p>')}</content>
        <created>20210102T030405Z</created>
        <updated>20220304T050607Z</updated>
        <tag>work</tag>
        <tag>Multi Word</tag>
      </note>`,
    )

    const notes = parseEnex(xml)
    expect(notes).toHaveLength(1)
    const note = at(notes)
    expect(note.title).toBe('My Note')
    expect(note.tags).toEqual(['work', 'Multi Word'])
    expect(note.createdMs).toBe(Date.UTC(2021, 0, 2, 3, 4, 5))
    expect(note.updatedMs).toBe(Date.UTC(2022, 2, 4, 5, 6, 7))
  })

  it('converts common ENML (headings, lists, bold, links, pre) to markdown', () => {
    const enml =
      '<h1>Heading</h1>' +
      '<p>Some <b>bold</b> and a <a href="https://example.com">link</a>.</p>' +
      '<ul><li>one</li><li>two</li></ul>' +
      '<pre><code>const x = 1;</code></pre>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    expect(note.markdown).toContain('# Heading')
    expect(note.markdown).toContain('**bold**')
    expect(note.markdown).toContain('[link](https://example.com)')
    expect(note.markdown).toContain('one')
    expect(note.markdown).toContain('two')
    // Fenced code block from <pre>.
    expect(note.markdown).toContain('```')
    expect(note.markdown).toContain('const x = 1;')
  })

  it('maps <en-todo> to task markers and drops <en-media>', () => {
    const enml =
      '<div><en-todo checked="true"/>Done thing</div>' +
      '<div><en-todo checked="false"/>Pending thing</div>' +
      '<div>See <en-media hash="abc123" type="image/png"/> here</div>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    expect(note.markdown).toContain('- [x] Done thing')
    expect(note.markdown).toContain('- [ ] Pending thing')
    // The en-media reference is dropped, leaving only the surrounding text.
    expect(note.markdown).not.toContain('en-media')
    expect(note.markdown).not.toContain('abc123')
    expect(note.markdown).toContain('See')
    expect(note.markdown).toContain('here')
  })

  it('yields one EnexNote per <note>', () => {
    const xml = enex(
      `<note><title>First</title><content>${content('<p>a</p>')}</content></note>`,
      `<note><title>Second</title><content>${content('<p>b</p>')}</content></note>`,
      `<note><title>Third</title><content>${content('<p>c</p>')}</content></note>`,
    )

    const notes = parseEnex(xml)
    expect(notes.map((n) => n.title)).toEqual(['First', 'Second', 'Third'])
  })

  it('falls back to a placeholder title when <title> is empty or missing', () => {
    const xml = enex(
      `<note><title></title><content>${content('<p>a</p>')}</content></note>`,
      `<note><content>${content('<p>b</p>')}</content></note>`,
    )

    const notes = parseEnex(xml)
    expect(at(notes, 0).title).toBe(UNTITLED_PLACEHOLDER)
    expect(at(notes, 1).title).toBe(UNTITLED_PLACEHOLDER)
  })

  it('returns null timestamps when <created>/<updated> are absent or malformed', () => {
    const xml = enex(
      `<note><title>T</title><content>${content('<p>a</p>')}</content>
        <created>not-a-date</created></note>`,
    )

    const note = at(parseEnex(xml))
    expect(note.createdMs).toBeNull()
    expect(note.updatedMs).toBeNull()
  })

  it('throws a clear error on malformed XML', () => {
    expect(() => parseEnex('<en-export><note><title>oops</note></en-export>')).toThrow(/ENEX/i)
  })

  it('handles an empty export with no notes', () => {
    expect(parseEnex(enex())).toEqual([])
  })
})

describe('parseEnex — <resource>/<en-media> attachments (#2513)', () => {
  // The five ASCII bytes "hello" (base64 `aGVsbG8=`) with the well-known
  // MD5 digest below. Evernote's `en-media hash` is the lowercase MD5 hex of
  // the resource's RAW decoded bytes, so this is what an `en-media` must carry
  // to reference the resource. Verifying the match end-to-end also proves the
  // module's MD5 implementation is correct.
  const HELLO_B64 = 'aGVsbG8='
  const HELLO_MD5 = '5d41402abc4b2a76b9719d911017c592'
  const HELLO_BYTES = [104, 101, 108, 108, 111]

  /** A `<resource>` block: base64 data + mime + optional file-name. */
  const resource = (b64: string, mime: string, fileName?: string): string => {
    const attrs =
      fileName === undefined
        ? ''
        : `<resource-attributes><file-name>${fileName}</file-name></resource-attributes>`
    return `<resource><data encoding="base64">${b64}</data><mime>${mime}</mime>${attrs}</resource>`
  }

  it('decodes a resource, MD5-matches en-media, and rewrites to a markdown embed', () => {
    const enml = `<div>See <en-media hash="${HELLO_MD5}" type="image/png"/> here</div>`
    const xml = enex(
      `<note><title>T</title><content>${content(enml)}</content>` +
        `${resource(HELLO_B64, 'image/png', 'pic.png')}</note>`,
    )

    const note = at(parseEnex(xml))
    // The en-media reference became a standard markdown image whose path is the
    // resource file-name; the raw en-media markup and hash are gone.
    expect(note.markdown).toContain('![](pic.png)')
    expect(note.markdown).not.toContain('en-media')
    expect(note.markdown).not.toContain(HELLO_MD5)

    // The decoded attachment is surfaced for the caller to ship as a VaultFile.
    expect(note.attachments).toHaveLength(1)
    const [att] = note.attachments
    if (att === undefined) throw new Error('expected an attachment')
    expect(att.path).toBe('pic.png')
    expect(att.mime).toBe('image/png')
    expect(Array.from(att.bytes)).toEqual(HELLO_BYTES)
  })

  it('matches a case-insensitive en-media hash and infers a name from the mime', () => {
    // No file-name on the resource ⇒ path falls back to `<md5>.<ext>`, and an
    // UPPERCASE en-media hash still matches (both sides are lowercased).
    const enml = `<div><en-media hash="${HELLO_MD5.toUpperCase()}" type="image/png"/></div>`
    const xml = enex(
      `<note><title>T</title><content>${content(enml)}</content>` +
        `${resource(HELLO_B64, 'image/png')}</note>`,
    )

    const note = at(parseEnex(xml))
    const expectedPath = `${HELLO_MD5}.png`
    expect(note.attachments).toHaveLength(1)
    expect(note.attachments[0]?.path).toBe(expectedPath)
    expect(note.markdown).toContain(`![](${expectedPath})`)
  })

  it('gracefully drops an en-media whose hash matches no resource (no crash)', () => {
    // A dangling reference: the note has NO resource for this hash.
    const enml = `<div>Before <en-media hash="deadbeefdeadbeefdeadbeefdeadbeef" type="image/png"/> after</div>`
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    // No attachment, no leaked markup, and the surrounding text survives.
    expect(note.attachments).toHaveLength(0)
    expect(note.markdown).not.toContain('en-media')
    expect(note.markdown).not.toContain('deadbeef')
    expect(note.markdown).toContain('Before')
    expect(note.markdown).toContain('after')
  })

  it('does not orphan-crash on a resource that no en-media references', () => {
    // The resource decodes fine but nothing in the body references it, so it
    // is simply never shipped (mirrors the folder import's unreferenced-asset
    // behaviour) — and the body still converts normally.
    const xml = enex(
      `<note><title>T</title><content>${content('<p>just text</p>')}</content>` +
        `${resource(HELLO_B64, 'image/png', 'unused.png')}</note>`,
    )

    const note = at(parseEnex(xml))
    expect(note.attachments).toHaveLength(0)
    expect(note.markdown).toContain('just text')
  })

  it('skips a resource with malformed base64 without failing the note', () => {
    // `@@@` is not valid base64; the resource is skipped, so the en-media that
    // would have matched it simply drops — the note still parses.
    const enml = `<div><en-media hash="${HELLO_MD5}" type="image/png"/>tail</div>`
    const xml = enex(
      `<note><title>T</title><content>${content(enml)}</content>` +
        `${resource('@@@not-base64@@@', 'image/png', 'bad.png')}</note>`,
    )

    const note = at(parseEnex(xml))
    expect(note.attachments).toHaveLength(0)
    expect(note.markdown).toContain('tail')
  })
})

describe('enexNoteToMarkdown', () => {
  it('emits frontmatter with ISO created/updated and source, tags, then body', () => {
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: '# Body\n\ntext',
      tags: ['work', 'Multi Word'],
      createdMs: Date.UTC(2021, 0, 2, 3, 4, 5),
      updatedMs: Date.UTC(2022, 2, 4, 5, 6, 7),
      attachments: [],
    })

    expect(md).toContain('---\n')
    expect(md).toContain(`created: "${new Date(Date.UTC(2021, 0, 2, 3, 4, 5)).toISOString()}"`)
    expect(md).toContain(`updated: "${new Date(Date.UTC(2022, 2, 4, 5, 6, 7)).toISOString()}"`)
    expect(md).toContain('source: evernote')
    // Single-word tag stays `#tag`; multi-word uses the `#[[…]]` form.
    expect(md).toContain('#work')
    expect(md).toContain('#[[Multi Word]]')
    // Body follows.
    expect(md).toContain('# Body')
    // Frontmatter opens the document.
    expect(md.startsWith('---\n')).toBe(true)
  })

  it('omits created/updated when null but always stamps source', () => {
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: 'body',
      tags: [],
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })

    expect(md).not.toContain('created:')
    expect(md).not.toContain('updated:')
    expect(md).toContain('source: evernote')
  })

  it('omits the tag line when there are no tags', () => {
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: 'body',
      tags: [],
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })

    expect(md).not.toContain('#')
  })
})

describe('sanitizeNoteTitleToFilename', () => {
  it('keeps slashes (namespace separator) and collapses whitespace', () => {
    expect(sanitizeNoteTitleToFilename('Projects/Roadmap')).toBe('Projects/Roadmap')
    expect(sanitizeNoteTitleToFilename('  A\n\tB  ')).toBe('A B')
  })

  it('falls back to the placeholder for an empty title', () => {
    expect(sanitizeNoteTitleToFilename('   ')).toBe(UNTITLED_PLACEHOLDER)
  })
})
