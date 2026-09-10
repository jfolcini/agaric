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
 *
 * What a real export looks like (#4815): every element pretty-printed, so each
 * text run carries the indentation; base64 wrapped across lines; the mime
 * table's extension per type; file-names that are Windows paths, traversals or
 * carry control characters; a resource embedded twice; and an MD5 payload on a
 * block boundary. Bodies are asserted WHOLE wherever a mutant could corrupt
 * the prose around what the importer rewrites (the embed splice, the task
 * markers, the en-crypt callouts, the frontmatter).
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
    // The literal, not the constant: the placeholder becomes the imported page
    // NAME, so an empty one would leave the note unnamed.
    expect(at(notes, 0).title).toBe('Untitled')
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

  it('rejects a timestamp with anything around it rather than parsing the middle', () => {
    // The stamp must be the WHOLE value: a run of digits embedded in other text
    // is not an Evernote timestamp, and dating a note from it would silently
    // invent a wrong created/updated property.
    const cases = ['x20210102T030405Z', '20210102T030405Zx', '2021-01-02T03:04:05Z']
    const xml = enex(
      ...cases.map(
        (raw) =>
          `<note><title>T</title><content>${content('<p>a</p>')}</content>` +
          `<created>${raw}</created></note>`,
      ),
    )

    expect(parseEnex(xml).map((n) => n.createdMs)).toEqual([null, null, null])
  })

  it('imports a pretty-printed note the same as a compact one', () => {
    // Every real .enex is indented, so each element's text run carries the
    // pretty-printer's newlines. They must not leak into the page name, the
    // tags or the dates — and a tag that is only whitespace is not a tag.
    const xml = enex(
      `<note>
        <title>
          My Note
        </title>
        <content>${content('<p>Body</p>')}</content>
        <created>
          20210102T030405Z
        </created>
        <tag>
          work
        </tag>
        <tag>   </tag>
      </note>`,
    )

    const note = at(parseEnex(xml))
    expect(note.title).toBe('My Note')
    expect(note.tags).toEqual(['work'])
    expect(note.createdMs).toBe(Date.UTC(2021, 0, 2, 3, 4, 5))
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

  it('splices the embed into the body text without disturbing the rest of it', () => {
    // The embed is spliced in AFTER Turndown runs, keyed by an index written
    // between two sentinel characters. Here the note's own digits run straight
    // into that index on both sides, so assert the WHOLE body: a splice that
    // keys off anything looser eats the user's numbers.
    const enml = `<div>Step 2 of 3<en-media hash="${HELLO_MD5}" type="image/png"/>4 done</div>`
    const xml = enex(
      `<note><title>T</title><content>${content(enml)}</content>` +
        `${resource(HELLO_B64, 'image/png', 'pic.png')}</note>`,
    )

    expect(at(parseEnex(xml)).markdown).toBe('Step 2 of 3![](pic.png)4 done')
  })

  it('decodes a resource whose base64 is wrapped across lines', () => {
    // Evernote wraps a resource's base64 payload at a fixed width, so the
    // `<data>` text run is full of newlines and indentation. They are not part
    // of the payload: strip them, or every attachment in a real export fails
    // to decode and silently disappears.
    const wrapped = `\n        ${HELLO_B64.slice(0, 4)}\n        ${HELLO_B64.slice(4)}\n      `
    const enml = `<div><en-media hash="${HELLO_MD5}" type="image/png"/></div>`
    const xml = enex(
      `<note><title>T</title><content>${content(enml)}</content>` +
        `${resource(wrapped, 'image/png', 'wrapped.png')}</note>`,
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual(['wrapped.png'])
    expect(Array.from(note.attachments[0]?.bytes ?? [])).toEqual(HELLO_BYTES)
  })

  it('matches a resource whose length lands on an MD5 block boundary', () => {
    // MD5 pads to 56 bytes mod 64; a 56-byte resource is the case where the
    // length field no longer fits and a SECOND block must be emitted. Get the
    // padding wrong and the digest is wrong, which shows up not as an error
    // but as an attachment that silently matches nothing. The hash below comes
    // from an independent MD5 implementation, not from this module.
    const b64 = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE='
    const md5 = 'a2f3e2024931bd470555002aa5ccc010'
    const enml = `<div><en-media hash="${md5}" type="application/pdf"/></div>`
    const xml = enex(
      `<note><title>T</title><content>${content(enml)}</content>` +
        `${resource(b64, 'application/pdf', 'block.pdf')}</note>`,
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual(['block.pdf'])
    expect(note.attachments[0]?.bytes).toHaveLength(56)
  })

  it('drops an <en-media> that carries no hash at all', () => {
    // Inline media Evernote never resolved: there is nothing to match, so the
    // reference goes away and the surrounding prose closes over it.
    const enml = '<div>Before <en-media type="image/png"/> after</div>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    expect(note.attachments).toHaveLength(0)
    expect(note.markdown).toBe('Before after')
  })

  it('matches a case-insensitive, whitespace-padded en-media hash and infers a name from the mime', () => {
    // No file-name on the resource ⇒ path falls back to `<md5>.<ext>`. An
    // UPPERCASE hash still matches (both sides are lowercased), and so does one
    // an indented .enex has padded — XML attribute-value normalization turns
    // the pretty-printer's newlines into spaces inside the attribute.
    const enml = `<div><en-media hash=" ${HELLO_MD5.toUpperCase()} " type="image/png"/></div>`
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
    // No attachment, no leaked markup, and the surrounding text closes over
    // the dropped reference.
    expect(note.attachments).toHaveLength(0)
    expect(note.markdown).toBe('Before after')
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
    i: { b64: 'aQ==', md5: '865c0c0b4ab0e063e5caa3387c1a8741' },
    j: { b64: 'ag==', md5: '363b122c528f54df4a0446b6bab05515' },
    k: { b64: 'aw==', md5: '8ce4b16b22b58894aa86c421e8759df3' },
    l: { b64: 'bA==', md5: '2db95e8e1a9267b7a1188556b2013b33' },
    m: { b64: 'bQ==', md5: '6f8f57715090da2632453988d9a1501b' },
    n: { b64: 'bg==', md5: '7b8b965ad4bca0e41ab51de7b31363a1' },
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

  it('gives each supported mime the extension its viewer expects', () => {
    // A nameless resource is written to the vault as `<md5>.<ext>`, and that
    // extension is all the OS has to open the file with. The subtype is NOT a
    // good enough guess for the common types — `audio/mpeg` is `.mp3`, not
    // `.mpeg`; `image/jpeg` is `.jpg`; `text/plain` is `.txt` — so the mapping
    // is pinned here type by type.
    const cases = [
      { byte: BYTE.a, mime: 'image/png', ext: 'png' },
      { byte: BYTE.b, mime: 'image/jpeg', ext: 'jpg' },
      { byte: BYTE.c, mime: 'image/jpg', ext: 'jpg' },
      { byte: BYTE.d, mime: 'image/gif', ext: 'gif' },
      { byte: BYTE.e, mime: 'image/webp', ext: 'webp' },
      { byte: BYTE.f, mime: 'image/svg+xml', ext: 'svg' },
      { byte: BYTE.g, mime: 'image/bmp', ext: 'bmp' },
      { byte: BYTE.h, mime: 'image/tiff', ext: 'tiff' },
      { byte: BYTE.i, mime: 'application/pdf', ext: 'pdf' },
      { byte: BYTE.j, mime: 'audio/mpeg', ext: 'mp3' },
      { byte: BYTE.k, mime: 'audio/mp4', ext: 'm4a' },
      { byte: BYTE.l, mime: 'audio/wav', ext: 'wav' },
      { byte: BYTE.m, mime: 'video/mp4', ext: 'mp4' },
      { byte: BYTE.n, mime: 'text/plain', ext: 'txt' },
    ]
    const xml = noteWith(
      cases.map((c) => ref(c.byte.md5)).join(''),
      ...cases.map((c) => res({ b64: c.byte.b64, mime: c.mime })),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual(cases.map((c) => `${c.byte.md5}.${c.ext}`))
  })

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

  it('reduces a resource file-name to a clean basename', () => {
    // The file-name is authored by the export, and it becomes a path in the
    // user's vault: a Windows path, a traversal prefix, the pretty-printer's
    // indentation and any control character in it must not survive into that
    // path — only the basename does.
    const xml = noteWith(
      ref(BYTE.a.md5) + ref(BYTE.b.md5) + ref(BYTE.c.md5),
      res({ b64: BYTE.a.b64, mime: 'image/png', fileName: 'C:\\Users\\me\\my report\t.png' }),
      res({ b64: BYTE.b.b64, mime: 'image/png', fileName: '../../../etc/passwd.png' }),
      res({ b64: BYTE.c.b64, mime: 'image/png', fileName: '\n      spaced.png\n    ' }),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual([
      'my report.png',
      'passwd.png',
      'spaced.png',
    ])
  })

  it('ships one attachment for two resources that hold the same bytes', () => {
    // Evernote embeds the same image twice as two <resource> blocks with
    // different names. They have one MD5, so they are one vault file — the
    // first name wins and the second block adds nothing.
    const xml = noteWith(
      ref(BYTE.d.md5),
      res({ b64: BYTE.d.b64, mime: 'image/png', fileName: 'first.png' }),
      res({ b64: BYTE.d.b64, mime: 'image/png', fileName: 'second.png' }),
    )

    const note = at(parseEnex(xml))
    expect(note.attachments.map((a) => a.path)).toEqual(['first.png'])
    expect(note.markdown).toBe('![](first.png)')
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

  it('converts a <content> whose root element is not <en-note>', () => {
    // ENML is supposed to be wrapped in <en-note>, but an export that wraps it
    // in anything else still has a body — take the document element rather
    // than dropping the note's content on the floor.
    const xml = enex(
      `<note><title>T</title><content><![CDATA[<div><p>rootless body</p></div>]]></content></note>`,
    )

    expect(at(parseEnex(xml)).markdown).toBe('rootless body')
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
    // exactly `- [ ]`. The list is preceded by prose, as a real note's is, so
    // the fold has to happen on every line of the body and not only on one
    // that starts it.
    const enml =
      '<p>intro</p>' +
      '<ul>' +
      '<li><en-todo checked="false"/>pending</li>' +
      '<li><en-todo checked="true"/>done</li>' +
      '</ul>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    // Exactly, so a bullet wrapping a task or an over-indented marker fails
    // here rather than needing its own negative assertion.
    expect(note.markdown).toBe('intro\n\n- [ ] pending\n- [x] done')
  })

  it('still renders standalone <en-todo>s (outside a list) as task lines', () => {
    // The <li> handling must not regress the div-wrapped form, and EVERY
    // checkbox converts — a note has more than one todo in it.
    const enml =
      '<div><en-todo checked="true"/>Done thing</div>' +
      '<div><en-todo checked="true"/>Done twice</div>' +
      '<div><en-todo checked="false"/>Pending thing</div>' +
      '<div><en-todo checked="false"/>Pending twice</div>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    expect(note.markdown).toBe(
      '- [x] Done thing\n\n- [x] Done twice\n\n- [ ] Pending thing\n\n- [ ] Pending twice',
    )
  })

  it('leaves no trailing whitespace after an empty checkbox at the end of a note', () => {
    // An unlabelled checkbox is the last thing in the body, so its marker's
    // trailing space would end the imported document — and land in the block.
    const enml = '<div>text</div><div><en-todo checked="true"/></div>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    expect(at(parseEnex(xml)).markdown).toBe('text\n\n- [x]')
  })

  it('unescapes the entities a CDATA body carries into the markdown', () => {
    // The `<content>` payload is CDATA, so the ENML inside it is re-escaped
    // before the outer XML parse and unescaped after. Losing that round trip
    // eats every `&` and `<` in the user's prose.
    const xml = enex(
      `<note><title>T</title><content><![CDATA[<en-note><p>Tom &amp; Jerry &lt;3</p></en-note>]]></content></note>`,
    )

    expect(at(parseEnex(xml)).markdown).toBe('Tom & Jerry <3')
  })

  it('renders a nested <table> as inline text without corrupting the outer table', () => {
    // GFM pipe tables cannot nest; the inner table is flattened to a single
    // safe inline run inside the outer cell (cells by ` / `, rows by ` ; `) so
    // the OUTER table structure stays valid and NO data is dropped. The nested
    // table is pretty-printed as an export's is, one cell spans two lines, one
    // carries a `|`, and one row is empty — each of which would break the
    // OUTER row if it reached it unflattened.
    const enml =
      '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody>' +
      '<tr><td>a</td><td>' +
      `<table>
        <thead><tr><th>N 1</th><th>N2</th></tr></thead>
        <tbody>
          <tr><td>  x
             y  </td><td>p|q</td></tr>
          <tr><td></td></tr>
          <tr><td>   </td><td>	</td></tr>
        </tbody>
      </table>` +
      '</td></tr></tbody></table>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const note = at(parseEnex(xml))
    const lines = note.markdown.split('\n').filter((l) => l.trim().length > 0)
    // Outer table: header row, separator row, one data row — intact.
    expect(lines[0]).toBe('| H1 | H2 |')
    expect(lines[1]).toBe('| --- | --- |')
    // The two-line cell is one run of single spaces, the `|` became a `/` so it
    // opens no column in the outer row, and neither the EMPTY row nor the
    // WHITESPACE-ONLY one adds a ` ; ` slot — the latter pins both the cell
    // trim and `flattenNestedTable`'s row filter.
    expect(lines[2]).toBe('| a | N 1 / N2 ; x y / p/q |')
    // Exactly the three table lines — the nested table did not leak extra
    // rows/pipes into the document.
    expect(lines).toHaveLength(3)
  })

  it('flattens tables nested three deep from the inside out', () => {
    // The innermost table has to be linearized FIRST: flatten an outer one
    // while it still holds a table and the inner cells collapse into each
    // other with no separator at all.
    const enml =
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>' +
      '<table><tbody><tr><td>m1</td><td>' +
      '<table><tbody><tr><td>i1</td><td>i2</td></tr></tbody></table>' +
      '</td></tr></tbody></table>' +
      '</td></tr></tbody></table>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const lines = at(parseEnex(xml))
      .markdown.split('\n')
      .filter((l) => l.trim().length > 0)
    expect(lines).toEqual(['| H |', '| --- |', '| m1 / i1 / i2 |'])
  })

  it('replaces every <en-crypt> block with a callout, not just the first', () => {
    // A note can hold several encrypted blocks; a second one left unconverted
    // would keep a private-use sentinel character in the imported text.
    const enml =
      '<div>a<en-crypt cipher="RC2">FIRSTCIPHER</en-crypt>b<en-crypt cipher="RC2">SECONDCIPHER</en-crypt>c</div>'
    const xml = enex(`<note><title>T</title><content>${content(enml)}</content></note>`)

    const callout =
      '> [!warning] Encrypted content was omitted during import (Evernote en-crypt block).'
    expect(at(parseEnex(xml)).markdown).toBe(`a\n\n${callout}\n\nb\n\n${callout}\n\nc`)
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
  // The composed document is what the markdown importer parses, so it is
  // asserted whole: a frontmatter block that does not close, a tag line glued
  // to the body, or a missing blank line between them all change what the
  // importer makes of the note.
  it('emits frontmatter with ISO created/updated and source, tags, then body', () => {
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: '# Body\n\ntext',
      tags: ['work', 'Multi Word'],
      createdMs: Date.UTC(2021, 0, 2, 3, 4, 5),
      updatedMs: Date.UTC(2022, 2, 4, 5, 6, 7),
      attachments: [],
    })

    expect(md).toBe(
      '---\n' +
        'created: "2021-01-02T03:04:05.000Z"\n' +
        'updated: "2022-03-04T05:06:07.000Z"\n' +
        'source: evernote\n' +
        '---\n' +
        '\n' +
        '#work #[[Multi Word]]\n' +
        '\n' +
        '# Body\n\ntext\n',
    )
  })

  it('omits created/updated when null, and the tag line when there are no tags', () => {
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: 'body',
      tags: [],
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })

    expect(md).toBe('---\nsource: evernote\n---\n\nbody\n')
  })

  it('emits frontmatter alone for a note with no tags and no body', () => {
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: '',
      tags: [],
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })

    expect(md).toBe('---\nsource: evernote\n---\n')
  })

  it('renders each tag as one token, whatever whitespace it carries', () => {
    // Evernote tag names are free text and a pretty-printed <tag> keeps its
    // line breaks. A token with whitespace left in it truncates at the first
    // space, so the note lands under the wrong tag — or none.
    const md = enexNoteToMarkdown({
      title: 'T',
      markdown: 'body',
      tags: ['work', 'Multi\n        Word', '  padded  '],
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })

    expect(md).toBe('---\nsource: evernote\n---\n\n#work #[[Multi Word]] #padded\n\nbody\n')
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
