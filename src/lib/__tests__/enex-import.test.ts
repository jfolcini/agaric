/**
 * Tests for the frontend-only Evernote `.enex` importer (#1282).
 *
 * Covers: title/tags/date extraction, ENML→Markdown conversion (headings,
 * lists, bold, links, `<pre>`), `<en-todo>` → task markers, `<en-media>`
 * dropped, multi-word tag → `#[[…]]`, malformed XML throwing, multiple notes,
 * empty-title placeholder, and timestamp epoch parsing (incl. null).
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

describe('enexNoteToMarkdown', () => {
  it('emits frontmatter with ISO created/updated and source, tags, then body', () => {
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: '# Body\n\ntext',
      tags: ['work', 'Multi Word'],
      createdMs: Date.UTC(2021, 0, 2, 3, 4, 5),
      updatedMs: Date.UTC(2022, 2, 4, 5, 6, 7),
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
