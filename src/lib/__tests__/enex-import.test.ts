/**
 * Tests for the frontend-only Evernote `.enex` importer (#1282).
 *
 * Covers: title/tags/date extraction, ENML→Markdown conversion (headings,
 * lists, bold, links, `<pre>`), `<en-todo>` → task markers, multi-word tag →
 * `#[[…]]`, malformed XML throwing, multiple notes, empty-title placeholder,
 * timestamp epoch parsing (incl. null), and `<resource>`/`<en-media>`
 * attachment ingestion (#2513): base64 decode + MD5 hash-match + `en-media` →
 * `![](path)` rewrite, dangling-hash graceful fallback, and orphan resources.
 *
 * Advanced ENML fidelity (#2513, part 3): `<en-todo>` at the start of an `<li>`
 * → native checkbox item, nested `<table>` flattened inline without corrupting
 * the outer table, and `<en-crypt>` → a `> [!warning]` callout placeholder that
 * never leaks the ciphertext.
 *
 * Resource path derivation (#4815): extension inferred from an unknown mime,
 * a file-name without one, file-name collisions across distinct resources, the
 * missing-`<data>` / missing-`<mime>` fallbacks, one attachment per resource
 * however many `<en-media>` reference it, and the empty/malformed-`<content>`
 * degradations.
 */

import { describe, expect, it } from 'vitest'

import {
  type EnexNote,
  enexNoteToMarkdown,
  parseEnex,
  sanitizeNoteTitleToFilename,
  UNTITLED_PLACEHOLDER,
} from '@/lib/enex-import'

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

describe('parseEnex — resource paths, mime fallbacks and en-media dedupe (#2513)', () => {
  /**
   * One-byte payloads, so each resource has distinct bytes (resources are
   * deduped by MD5) and a hash an `<en-media>` can reference. Base64 and MD5
   * are the real values for the single ASCII byte named by the key.
   */
  const BYTE = {
    a: { b64: 'YQ==', md5: '0cc175b9c0f1b6a831c399e269772661' },
    b: { b64: 'Yg==', md5: '92eb5ffee6ae2fec3ad71c777531578f' },
    c: { b64: 'Yw==', md5: '4a8a08f09d37b73795649038408b5f33' },
    d: { b64: 'ZA==', md5: '8277e0910d750195b448797616e091ad' },
    e: { b64: 'ZQ==', md5: 'e1671797c52e15f763380b45e841ec32' },
    f: { b64: 'Zg==', md5: '8fa14cdd754f91cc6554c9e71929cce7' },
    g: { b64: 'Zw==', md5: 'b2f5ff47436671b6e533d8dc3614845d' },
    h: { b64: 'aA==', md5: '2510c39011c5be704182423e3a695e91' },
  } as const

  /** A `<resource>` block with every child optional (missing `<data>`/`<mime>`). */
  function res(parts: { b64?: string; mime?: string; fileName?: string }): string {
    const data = parts.b64 === undefined ? '' : `<data encoding="base64">${parts.b64}</data>`
    const mime = parts.mime === undefined ? '' : `<mime>${parts.mime}</mime>`
    const name =
      parts.fileName === undefined
        ? ''
        : `<resource-attributes><file-name>${parts.fileName}</file-name></resource-attributes>`
    return `<resource>${data}${mime}${name}</resource>`
  }

  /** One `<en-media>` reference, in its own block. */
  const ref = (md5: string): string => `<div><en-media hash="${md5}" type="x/y"/></div>`

  /** A single-note ENEX: body `enml` plus the given `<resource>` blocks. */
  function noteWith(enml: string, ...resources: string[]): string {
    return enex(
      `<note><title>T</title><content>${content(enml)}</content>${resources.join('')}</note>`,
    )
  }

  it('derives an extension from an unknown mime, falling back to .bin', () => {
    // None of these mimes is in the known-mime table, so the extension comes
    // from the SUBTYPE: non-alphanumerics stripped, lowercased, and accepted
    // only when it is 1..5 characters — otherwise `bin`.
    //   image/HEIC  → `heic`  (uppercase subtype is lowercased)
    //   image/x-icon→ `xicon` (the `-` is stripped; 5 chars is the max accepted)
    //   application/vnd.oasis…→ `bin` (subtype too long once stripped)
    //   notamime    → `bin`  (no `/` at all ⇒ no subtype)
    const cases = [
      { byte: BYTE.a, mime: 'image/HEIC', ext: 'heic' },
      { byte: BYTE.b, mime: 'image/x-icon', ext: 'xicon' },
      { byte: BYTE.c, mime: 'application/vnd.oasis.opendocument.text', ext: 'bin' },
      { byte: BYTE.d, mime: 'notamime', ext: 'bin' },
    ]
    const xml = noteWith(
      cases.map((c) => ref(c.byte.md5)).join(''),
      ...cases.map((c) => res({ b64: c.byte.b64, mime: c.mime })),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual(cases.map((c) => `${c.byte.md5}.${c.ext}`))
    // The mime is passed through verbatim for the caller to ship.
    expect(note.attachments.map((a) => a.mime)).toEqual(cases.map((c) => c.mime))
  })

  it('appends a mime-derived extension to a file-name that has none', () => {
    // `photo` has no extension ⇒ one is appended from the mime; `already.png`
    // already ends in an extension ⇒ it is left exactly as authored.
    const xml = noteWith(
      ref(BYTE.e.md5) + ref(BYTE.f.md5),
      res({ b64: BYTE.e.b64, mime: 'image/png', fileName: 'photo' }),
      res({ b64: BYTE.f.b64, mime: 'image/png', fileName: 'already.png' }),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual(['photo.png', 'already.png'])
    expect(note.markdown).toContain('![](photo.png)')
    expect(note.markdown).toContain('![](already.png)')
  })

  it('disambiguates two distinct resources that share one file-name', () => {
    // Both resources are called `a.png` but hold different bytes: the first
    // keeps the name, the second gets a short-hash suffix on the STEM (before
    // the extension) so both survive as distinct vault files. The one-character
    // stem puts the dot at index 1, so a suffix spliced at the wrong offset —
    // or computed from the wrong end of the name — moves the extension.
    const xml = noteWith(
      ref(BYTE.g.md5) + ref(BYTE.h.md5),
      res({ b64: BYTE.g.b64, mime: 'image/png', fileName: 'a.png' }),
      res({ b64: BYTE.h.b64, mime: 'image/png', fileName: 'a.png' }),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual([
      'a.png',
      `a-${BYTE.h.md5.slice(0, 8)}.png`,
    ])
  })

  it('skips a resource with no <data> before it can claim a file-name', () => {
    // The data-less resource comes FIRST and shares the file-name of the real
    // one. It must be skipped outright — if it were indexed, it would take
    // `x.png` and push the real attachment onto a disambiguated path.
    const xml = noteWith(
      ref(BYTE.a.md5),
      res({ mime: 'image/png', fileName: 'x.png' }),
      res({ b64: BYTE.a.b64, mime: 'image/png', fileName: 'x.png' }),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments).toHaveLength(1)
    expect(note.attachments[0]?.path).toBe('x.png')
  })

  it('defaults a resource with no <mime> to application/octet-stream', () => {
    const xml = noteWith(ref(BYTE.b.md5), res({ b64: BYTE.b.b64 }))

    const note = at(parseEnex(xml))
    expect(note.attachments).toHaveLength(1)
    expect(note.attachments[0]?.mime).toBe('application/octet-stream')
    // `octetstream` is longer than the 5-char subtype cap ⇒ the `.bin` fallback.
    expect(note.attachments[0]?.path).toBe(`${BYTE.b.md5}.bin`)
  })

  it('trims a pretty-printed <mime> before shipping it', () => {
    // A pretty-printed .enex indents its elements, so `<mime>`'s text run
    // carries newlines. The caller ships this value as the attachment's
    // content type, so it must be the trimmed mime, not the raw run.
    const xml = noteWith(ref(BYTE.f.md5), res({ b64: BYTE.f.b64, mime: '\n      image/png\n    ' }))

    const note = at(parseEnex(xml))
    expect(note.attachments[0]?.mime).toBe('image/png')
  })

  it('ships one attachment for a resource referenced twice, embedding it twice', () => {
    const xml = noteWith(
      ref(BYTE.c.md5) + ref(BYTE.c.md5),
      res({ b64: BYTE.c.b64, mime: 'image/png', fileName: 'twice.png' }),
    )

    const note = at(parseEnex(xml))
    // Shipped once (the caller writes one vault file)…
    expect(note.attachments.map((a) => a.path)).toEqual(['twice.png'])
    // …but both references become embeds.
    expect(note.markdown.split('![](twice.png)')).toHaveLength(3)
  })

  it('ships both attachments when two distinct resources are referenced', () => {
    const xml = noteWith(
      ref(BYTE.d.md5) + ref(BYTE.e.md5),
      res({ b64: BYTE.d.b64, mime: 'image/png', fileName: 'one.png' }),
      res({ b64: BYTE.e.b64, mime: 'image/png', fileName: 'two.png' }),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual(['one.png', 'two.png'])
  })
})

describe('parseEnex — notes whose <content> yields no body', () => {
  it('imports a note with an empty or missing <content> as an empty body', () => {
    const xml = enex(
      `<note><title>Empty</title><content></content></note>`,
      `<note><title>Missing</title></note>`,
    )

    const notes = parseEnex(xml)
    expect(notes.map((n) => n.title)).toEqual(['Empty', 'Missing'])
    expect(notes.map((n) => n.markdown)).toEqual(['', ''])
  })

  it('imports a note whose ENML is malformed, with an empty body', () => {
    // The `<content>` payload is not well-formed XML (`<p>` never closes). The
    // ENML is dropped, but the note itself — title, tags, timestamps — still
    // imports rather than failing the whole file.
    const xml = enex(
      `<note><title>Broken</title>` +
        `<content><![CDATA[<en-note><p>unclosed</en-note>]]></content>` +
        `<tag>work</tag></note>`,
    )

    const note = at(parseEnex(xml))
    expect(note.title).toBe('Broken')
    expect(note.tags).toEqual(['work'])
    expect(note.markdown).toBe('')
  })
})

describe('parseEnex — advanced ENML fidelity (#2513)', () => {
  it('renders <en-todo> at the start of an <li> as a native checkbox item', () => {
    // A task list authored as `<li><en-todo/>text</li>` must become a native
    // GFM task item (`- [ ] `/`- [x] `), NOT a bullet wrapping a task
    // (`- - [ ] `) nor a wide-indented `-   [ ]` — Agaric's task parser needs
    // exactly `- [ ]`.
    const enml =
      '<ul>' +
      '<li><en-todo checked="false"/>pending</li>' +
      '<li><en-todo checked="true"/>done</li>' +
      '</ul>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    expect(note.markdown).toContain('- [ ] pending')
    expect(note.markdown).toContain('- [x] done')
    // No bullet-wrapping-a-task and no over-indented marker.
    expect(note.markdown).not.toContain('- - [')
    expect(note.markdown).not.toContain('-   [')
    // Each task is its own line — assert the whole body, exactly.
    expect(note.markdown).toBe('- [ ] pending\n- [x] done')
  })

  it('still renders a standalone <en-todo> (outside a list) as a task line', () => {
    // The <li> handling must not regress the div-wrapped form (existing test).
    const enml = '<div><en-todo checked="true"/>Done thing</div>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    expect(note.markdown).toBe('- [x] Done thing')
  })

  it('renders a nested <table> as inline text without corrupting the outer table', () => {
    // GFM pipe tables cannot nest; the inner table is flattened to a single
    // safe inline run inside the outer cell (cells by ` / `, rows by ` ; `) so
    // the OUTER table structure stays valid and NO data is dropped.
    const enml =
      '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody>' +
      '<tr><td>a</td><td>' +
      '<table><thead><tr><th>N1</th><th>N2</th></tr></thead>' +
      '<tbody><tr><td>x</td><td>y</td></tr></tbody></table>' +
      '</td></tr></tbody></table>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    const lines = note.markdown.split('\n').filter((l) => l.trim().length > 0)
    // Outer table: header row, separator row, one data row — intact.
    expect(lines[0]).toBe('| H1 | H2 |')
    expect(lines[1]).toBe('| --- | --- |')
    expect(lines[2]).toBe('| a | N1 / N2 ; x / y |')
    // Exactly the three table lines — the nested table did not leak extra
    // rows/pipes into the document.
    expect(lines).toHaveLength(3)
    // Every nested cell value survives (nothing dropped).
    for (const value of ['N1', 'N2', 'x', 'y']) expect(note.markdown).toContain(value)
  })

  it('replaces an <en-crypt> block with a callout and never leaks the ciphertext', () => {
    const cipher = 'U2FsdGVkX1SECRETCIPHERTEXT'
    const enml = `<div>Before<en-crypt cipher="RC2" length="64" hint="a hint">${cipher}</en-crypt>After</div>`
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    // A clear, non-destructive callout marker stands in for the encrypted block.
    expect(note.markdown).toContain('> [!warning]')
    expect(note.markdown.toLowerCase()).toContain('encrypted content')
    // The ciphertext is NOT leaked and the raw `<en-crypt>` markup / its
    // attributes never survive (the placeholder's descriptive prose may name
    // "en-crypt", so we check for the tag and attribute markup specifically).
    expect(note.markdown).not.toContain(cipher)
    expect(note.markdown).not.toContain('<en-crypt')
    expect(note.markdown).not.toContain('cipher=')
    expect(note.markdown).not.toContain('a hint')
    // Surrounding text is preserved around the placeholder.
    expect(note.markdown).toContain('Before')
    expect(note.markdown).toContain('After')
  })

  it('does not crash on malformed nested-fidelity ENML (empty en-crypt, empty nested table)', () => {
    const enml =
      '<div><en-crypt></en-crypt></div>' +
      '<table><thead><tr><th>H</th></tr></thead><tbody>' +
      '<tr><td><table></table></td></tr></tbody></table>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    // Graceful degradation: parses without throwing and still emits the callout.
    expect(() => parseEnex(xml)).not.toThrow()
    const note = at(parseEnex(xml))
    expect(note.markdown).toContain('> [!warning]')
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
