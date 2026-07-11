/**
 * Tests for the frontend-only Joplin `.jex` importer (#2513, part 2).
 *
 * A `.jex` export is a tar archive of `<id>.md` items (notes/folders/resources,
 * each with a trailing `key: value` metadata block) plus `resources/<id>.<ext>`
 * binaries. These tests build a tiny synthetic tar in memory and assert:
 *  - notes (`type_: 1`) become {@link JexNote}s with folder→namespace titles,
 *  - an embedded resource is decoded, its `:/id` embed rewritten to the vault
 *    path, and its bytes surfaced as an attachment,
 *  - an internal note link `:/<noteId>` resolves to a `[[Target]]` wikilink,
 *  - encrypted / unreadable items are skipped and counted (no crash),
 *  - a malformed/empty archive degrades to zero notes rather than throwing,
 *  - `jexNoteToMarkdown` stamps `source: joplin` frontmatter.
 */

import { describe, expect, it } from 'vitest'

import { jexNoteToMarkdown, parseJex, sanitizeNoteTitleToFilename } from '../jex-import'

// --- Synthetic USTAR tar builder -------------------------------------------

const enc = new TextEncoder()

/** Encode a number as a NUL-terminated octal tar header field of `len` bytes. */
function octalField(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, '0')}\0`
}

/** Build a minimal-but-valid USTAR archive from `{ name, data }` members. */
function buildTar(members: { name: string; data: Uint8Array }[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const { name, data } of members) {
    const header = new Uint8Array(512)
    header.set(enc.encode(name).subarray(0, 100), 0)
    header.set(enc.encode('0000644\0'), 100) // mode
    header.set(enc.encode('0000000\0'), 108) // uid
    header.set(enc.encode('0000000\0'), 116) // gid
    header.set(enc.encode(octalField(data.length, 12)), 124) // size
    header.set(enc.encode('00000000000\0'), 136) // mtime
    header[156] = 0x30 // typeflag '0' (regular file)
    header.set(enc.encode('ustar\0'), 257)
    header.set(enc.encode('00'), 263)
    // Checksum: sum with the field pre-filled with spaces, then write it back.
    for (let i = 148; i < 156; i++) header[i] = 0x20
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0
    header.set(enc.encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148)
    blocks.push(header)
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data)
    blocks.push(padded)
  }
  // Two trailing all-zero blocks mark end-of-archive.
  blocks.push(new Uint8Array(512), new Uint8Array(512))
  const total = blocks.reduce((n, b) => n + b.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const b of blocks) {
    out.set(b, off)
    off += b.length
  }
  return out
}

// --- Joplin item helpers ----------------------------------------------------

const FOLDER_ID = 'a'.repeat(32)
const NOTE1_ID = 'b'.repeat(32)
const NOTE2_ID = 'c'.repeat(32)
const RES_ID = 'd'.repeat(32)
const HELLO_BYTES = new Uint8Array([104, 101, 108, 108, 111]) // "hello"

/** Serialize a Joplin item: content, a blank line, then `key: value` metadata. */
function joplinItem(content: string, props: Record<string, string>): string {
  const meta = Object.entries(props)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  return `${content}\n\n${meta}\n`
}

/** A `.md` tar member from an item text. */
function itemMember(id: string, text: string): { name: string; data: Uint8Array } {
  return { name: `${id}.md`, data: enc.encode(text) }
}

/** Build a full `.jex` archive: one folder, two notes, one resource + binary. */
function sampleJex(extra: { name: string; data: Uint8Array }[] = []): Uint8Array {
  const folder = joplinItem('Projects', { id: FOLDER_ID, parent_id: '', type_: '2' })
  const note1 = joplinItem(`Note One\n\nSee ![pic](:/${RES_ID}) and [go to beta](:/${NOTE2_ID}).`, {
    id: NOTE1_ID,
    parent_id: FOLDER_ID,
    created_time: '2021-01-02T03:04:05.000Z',
    updated_time: '2022-03-04T05:06:07.000Z',
    type_: '1',
  })
  const note2 = joplinItem('Note Two\n\nBody of beta.', {
    id: NOTE2_ID,
    parent_id: '',
    type_: '1',
  })
  const resourceMeta = joplinItem('pic.png', {
    id: RES_ID,
    mime: 'image/png',
    file_extension: 'png',
    type_: '4',
  })
  return buildTar([
    itemMember(FOLDER_ID, folder),
    itemMember(NOTE1_ID, note1),
    itemMember(NOTE2_ID, note2),
    itemMember(RES_ID, resourceMeta),
    { name: `resources/${RES_ID}.png`, data: HELLO_BYTES },
    ...extra,
  ])
}

describe('parseJex', () => {
  it('maps notes to pages, namespacing by folder', () => {
    const { notes, skipped } = parseJex(sampleJex())
    expect(skipped).toBe(0)
    expect(notes).toHaveLength(2)

    const byTitle = new Map(notes.map((n) => [n.title, n]))
    // Note One lives under the "Projects" notebook → namespaced page title.
    expect(byTitle.has('Projects/Note One')).toBe(true)
    // Note Two is at the root → bare title.
    expect(byTitle.has('Note Two')).toBe(true)
  })

  it('ingests a resource: rewrites the embed and surfaces the bytes', () => {
    const { notes } = parseJex(sampleJex())
    const note = notes.find((n) => n.title === 'Projects/Note One')
    if (note === undefined) throw new Error('expected Note One')

    // The `:/id` embed became a standard markdown image at the resource path;
    // the raw Joplin ref is gone.
    expect(note.markdown).toContain('![pic](pic.png)')
    expect(note.markdown).not.toContain(`:/${RES_ID}`)

    // The decoded resource bytes ship as an attachment at that path.
    expect(note.attachments).toHaveLength(1)
    const [att] = note.attachments
    if (att === undefined) throw new Error('expected an attachment')
    expect(att.path).toBe('pic.png')
    expect(att.mime).toBe('image/png')
    expect(Array.from(att.bytes)).toEqual([104, 101, 108, 108, 111])
  })

  it('resolves an internal note link to a wikilink', () => {
    const { notes } = parseJex(sampleJex())
    const note = notes.find((n) => n.title === 'Projects/Note One')
    if (note === undefined) throw new Error('expected Note One')

    // `[go to beta](:/<note2 id>)` → `[[Note Two]]` (link target preserved).
    expect(note.markdown).toContain('[[Note Two]]')
    expect(note.markdown).not.toContain(`:/${NOTE2_ID}`)
  })

  it('parses created/updated times into epoch ms', () => {
    const { notes } = parseJex(sampleJex())
    const note = notes.find((n) => n.title === 'Projects/Note One')
    if (note === undefined) throw new Error('expected Note One')
    expect(note.createdMs).toBe(Date.UTC(2021, 0, 2, 3, 4, 5))
    expect(note.updatedMs).toBe(Date.UTC(2022, 2, 4, 5, 6, 7))
  })

  it('skips an encrypted item and counts it', () => {
    const encrypted = itemMember(
      'e'.repeat(32),
      joplinItem('Secret', {
        id: 'e'.repeat(32),
        parent_id: '',
        encryption_applied: '1',
        type_: '1',
      }),
    )
    const { notes, skipped } = parseJex(sampleJex([encrypted]))
    expect(skipped).toBe(1)
    // The two normal notes still import; the encrypted one does not.
    expect(notes.map((n) => n.title).toSorted()).toEqual(['Note Two', 'Projects/Note One'])
  })

  it('leaves an unresolved reference as a stable placeholder', () => {
    const dangling = 'f'.repeat(32)
    const noteId = '9'.repeat(32)
    const note = joplinItem(`Ghost Note\n\nRef to [ghost](:/${dangling}).`, {
      id: noteId,
      parent_id: '',
      type_: '1',
    })
    const archive = buildTar([itemMember(noteId, note)])
    const { notes } = parseJex(archive)
    expect(notes).toHaveLength(1)
    // Neither a resource nor a known note → the raw ref survives untouched.
    expect(notes[0]?.markdown).toContain(`:/${dangling}`)
  })

  it('degrades to zero notes on an empty/garbage archive without throwing', () => {
    expect(parseJex(new Uint8Array(0))).toEqual({ notes: [], skipped: 0 })
    expect(parseJex(new Uint8Array(1024))).toEqual({ notes: [], skipped: 0 })
  })
})

describe('jexNoteToMarkdown', () => {
  it('emits frontmatter with ISO created/updated and source: joplin, then body', () => {
    const md = jexNoteToMarkdown({
      title: 'T',
      markdown: '# Body\n\ntext',
      createdMs: Date.UTC(2021, 0, 2, 3, 4, 5),
      updatedMs: Date.UTC(2022, 2, 4, 5, 6, 7),
      attachments: [],
    })
    expect(md.startsWith('---\n')).toBe(true)
    expect(md).toContain(`created: "${new Date(Date.UTC(2021, 0, 2, 3, 4, 5)).toISOString()}"`)
    expect(md).toContain(`updated: "${new Date(Date.UTC(2022, 2, 4, 5, 6, 7)).toISOString()}"`)
    expect(md).toContain('source: joplin')
    expect(md).toContain('# Body')
  })

  it('omits created/updated when null but always stamps source', () => {
    const md = jexNoteToMarkdown({
      title: 'T',
      markdown: 'body',
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })
    expect(md).not.toContain('created:')
    expect(md).not.toContain('updated:')
    expect(md).toContain('source: joplin')
  })
})

describe('sanitizeNoteTitleToFilename', () => {
  it('keeps slashes (namespace separator) and collapses whitespace', () => {
    expect(sanitizeNoteTitleToFilename('Projects/Roadmap')).toBe('Projects/Roadmap')
    expect(sanitizeNoteTitleToFilename('  A\n\tB  ')).toBe('A B')
  })
})
