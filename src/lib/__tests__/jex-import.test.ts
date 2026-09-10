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
 *  - `jexNoteToMarkdown` stamps `source: joplin` frontmatter,
 *  - every resource-naming fallback (mime→extension table, id-named orphan
 *    binaries, collision disambiguation) and the item/tar-header shapes a
 *    hand-written export hits but a well-formed one does not (#4816),
 *  - where the tar scan starts and stops, the notebook chain a note hangs off,
 *    and the exact bytes `jexNoteToMarkdown` hands the markdown importer.
 *
 * ACCEPTED GAPS (#4816). The mutants still surviving here recur in five shapes,
 * none of them worth a test — reach for one of these before writing another:
 *  - the operand of a `??` or `!== undefined` the type system demands and the
 *    code cannot reach (`lines[i] ?? ''`, `known[mime] ?? 'bin'`, `.pop() ?? ''`);
 *  - a normalization applied twice — `parseJoplinTime`'s `.trim()` on a value
 *    `unserialize` already trimmed, `readOctalField`'s NUL/space skip that
 *    `Number.parseInt` tolerates anyway;
 *  - a guard whose failure is unobservable: a `Map` entry keyed `''` (every
 *    `id.length > 0` site) is never looked up, because every lookup key is
 *    non-empty;
 *  - `unserialize`'s blank-line branch versus its no-colon branch, which differ
 *    only by whether a blank line joins `contentLines` — and `normalizeBody`
 *    strips it either way;
 *  - a tar header no writer emits: a member name filling all 100 bytes with no
 *    NUL, an empty member name, a zero-length member as the final block.
 */

import { describe, expect, it } from 'vitest'

import { UNTITLED_PLACEHOLDER } from '@/lib/enex-import'
import { jexNoteToMarkdown, parseJex } from '@/lib/jex-import'

// --- Synthetic USTAR tar builder -------------------------------------------

const enc = new TextEncoder()

/** Encode a number as a NUL-terminated octal tar header field of `len` bytes. */
function octalField(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, '0')}\0`
}

/** A member of the synthetic archive. */
interface TarMember {
  name: string
  data: Uint8Array
  /** USTAR `prefix` field (offset 345); the reader joins it as `<prefix>/<name>`. */
  prefix?: string
  /** USTAR type-flag byte (offset 156); defaults to `'0'` (regular file). */
  typeflag?: number
}

/** Build a minimal-but-valid USTAR archive from `{ name, data }` members. */
function buildTar(members: TarMember[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const { name, data, prefix, typeflag } of members) {
    const header = new Uint8Array(512)
    header.set(enc.encode(name).subarray(0, 100), 0)
    header.set(enc.encode('0000644\0'), 100) // mode
    header.set(enc.encode('0000000\0'), 108) // uid
    header.set(enc.encode('0000000\0'), 116) // gid
    header.set(enc.encode(octalField(data.length, 12)), 124) // size
    header.set(enc.encode('00000000000\0'), 136) // mtime
    header[156] = typeflag ?? 0x30 // typeflag '0' (regular file)
    header.set(enc.encode('ustar\0'), 257)
    if (prefix !== undefined) header.set(enc.encode(prefix).subarray(0, 155), 345)
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
function itemMember(id: string, text: string): TarMember {
  return { name: `${id}.md`, data: enc.encode(text) }
}

/** Build a full `.jex` archive: one folder, two notes, one resource + binary. */
function sampleJex(extra: TarMember[] = []): Uint8Array {
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
  // The whole string is asserted, not just its parts: a frontmatter block that
  // is never closed swallows the body, and a body welded onto the closing `---`
  // lands inside the frontmatter instead of on the page.
  it('emits frontmatter with ISO created/updated and source: joplin, then body', () => {
    const md = jexNoteToMarkdown({
      title: 'T',
      markdown: '# Body\n\ntext',
      createdMs: Date.UTC(2021, 0, 2, 3, 4, 5),
      updatedMs: Date.UTC(2022, 2, 4, 5, 6, 7),
      attachments: [],
    })
    expect(md).toBe(
      [
        '---',
        `created: "${new Date(Date.UTC(2021, 0, 2, 3, 4, 5)).toISOString()}"`,
        `updated: "${new Date(Date.UTC(2022, 2, 4, 5, 6, 7)).toISOString()}"`,
        'source: joplin',
        '---',
        '',
        '# Body',
        '',
        'text',
        '',
      ].join('\n'),
    )
  })

  it('omits created/updated when null but always stamps source', () => {
    const md = jexNoteToMarkdown({
      title: 'T',
      markdown: 'body',
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })
    expect(md).toBe('---\nsource: joplin\n---\n\nbody\n')
  })

  it('emits frontmatter alone, with no trailing blank, for an empty body', () => {
    const md = jexNoteToMarkdown({
      title: 'T',
      markdown: '',
      createdMs: null,
      updatedMs: null,
      attachments: [],
    })
    expect(md).toBe('---\nsource: joplin\n---\n')
  })
})

// --- Resource naming ---------------------------------------------------------
//
// A resource's vault path is derived from three independent inputs — the tar
// member's own extension, the `type_: 4` metadata item's `file_extension` /
// `mime` / title, and a collision with an already-claimed path. The suite above
// only ever exercises the fully-specified case (metadata title `pic.png`, tar
// name `<id>.png`), so the fallbacks below need archives of their own.

/** One resource to embed in the throwaway archive `jexWithResources` builds. */
interface ResourceSpec {
  id: string
  /** Member name under `resources/`; no extension means the reader sees `ext: ''`. */
  fileName: string
  /** `type_: 4` metadata props. Omitted entirely for a binary with no metadata item. */
  meta?: Record<string, string>
  /** The metadata item's first content line — Joplin's resource title. */
  metaTitle?: string
}

const EMBEDDER_ID = '7e'.repeat(16)

/** Archive holding one root note that embeds every `specs` resource, in order. */
function jexWithResources(specs: ResourceSpec[]): Uint8Array {
  const body = specs.map((spec, i) => `![r${i}](:/${spec.id})`).join('\n')
  const members: TarMember[] = [
    itemMember(
      EMBEDDER_ID,
      joplinItem(`Embedder\n\n${body}`, { id: EMBEDDER_ID, parent_id: '', type_: '1' }),
    ),
  ]
  for (const spec of specs) {
    if (spec.meta !== undefined) {
      const props = { id: spec.id, ...spec.meta, type_: '4' }
      members.push(itemMember(spec.id, joplinItem(spec.metaTitle ?? '', props)))
    }
    members.push({ name: `resources/${spec.fileName}`, data: HELLO_BYTES })
  }
  return buildTar(members)
}

/** The attachments the embedding note ended up shipping, in reference order. */
function embeddedAttachments(specs: ResourceSpec[]): { path: string; mime: string }[] {
  const { notes } = parseJex(jexWithResources(specs))
  const note = notes.find((n) => n.title === 'Embedder')
  if (note === undefined) throw new Error('expected the embedding note')
  return note.attachments.map((a) => ({ path: a.path, mime: a.mime }))
}

/** A distinct 32-hex resource id per mime case. */
function mimeCaseId(index: number): string {
  return `${'0'.repeat(30)}${index.toString(16).padStart(2, '0')}`
}

/** `mime → expected extension`, covering the known table and both fallbacks. */
const MIME_EXT_CASES: readonly (readonly [mime: string, ext: string])[] = [
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['image/bmp', 'bmp'],
  ['image/tiff', 'tiff'],
  ['application/pdf', 'pdf'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp4', 'm4a'],
  ['audio/wav', 'wav'],
  ['video/mp4', 'mp4'],
  ['text/plain', 'txt'],
  // Unknown mime: the subtype, punctuation-stripped and lowercased, when it is
  // short enough to pass for an extension...
  ['image/X-Icon', 'xicon'],
  // ...and 'bin' when it is not — too long, or no subtype at all.
  ['application/octet-stream', 'bin'],
  ['binaryjunk', 'bin'],
]

describe('parseJex resource naming', () => {
  it('derives the extension from the mime when neither the tar name nor the metadata has one', () => {
    const specs = MIME_EXT_CASES.map(([mime], i) => ({
      id: mimeCaseId(i),
      fileName: mimeCaseId(i), // no extension on the member name
      meta: { mime }, // no file_extension, no title
    }))
    expect(embeddedAttachments(specs)).toEqual(
      MIME_EXT_CASES.map(([mime, ext], i) => ({ path: `${mimeCaseId(i)}.${ext}`, mime })),
    )
  })

  it('names a binary with no metadata item by its id and an octet-stream extension', () => {
    const orphan = '5e'.repeat(16)
    expect(embeddedAttachments([{ id: orphan, fileName: orphan }])).toEqual([
      { path: `${orphan}.bin`, mime: 'application/octet-stream' },
    ])
  })

  it('keeps the extension the tar member carries over the metadata file_extension', () => {
    // The bytes are what they are: the member's own suffix wins over metadata
    // that disagrees with it, so the vault file is not renamed to a wrong type.
    const id = '4e'.repeat(16)
    const specs = [
      { id, fileName: `${id}.jpg`, meta: { mime: 'image/png', file_extension: 'png' } },
    ]
    expect(embeddedAttachments(specs)).toEqual([{ path: `${id}.jpg`, mime: 'image/png' }])
  })

  it('keeps an orphan binary extension when no metadata item names one', () => {
    const orphan = '3e'.repeat(16)
    expect(embeddedAttachments([{ id: orphan, fileName: `${orphan}.png` }])).toEqual([
      { path: `${orphan}.png`, mime: 'application/octet-stream' },
    ])
  })

  it('falls back to octet-stream when the metadata omits the mime, keeping its file_extension', () => {
    const id = '6f'.repeat(16)
    const specs = [{ id, fileName: id, meta: { file_extension: 'png' } }]
    expect(embeddedAttachments(specs)).toEqual([
      { path: `${id}.png`, mime: 'application/octet-stream' },
    ])
  })

  it('appends the extension to a metadata title that carries none', () => {
    const id = '7a'.repeat(16)
    const specs = [
      {
        id,
        fileName: `${id}.png`,
        meta: { mime: 'image/png', file_extension: 'png' },
        metaTitle: 'diagram',
      },
    ]
    expect(embeddedAttachments(specs)).toEqual([{ path: 'diagram.png', mime: 'image/png' }])
  })

  it('reduces a resource title carrying a path to a clean basename', () => {
    const id = '2e'.repeat(16)
    const specs = [
      {
        id,
        fileName: `${id}.png`,
        meta: { mime: 'image/png', file_extension: 'png' },
        // A title as Windows handed it over, with a stray control character.
        // The title becomes a vault file path, so it keeps neither the
        // directories nor anything unprintable.
        metaTitle: 'C:\\photos\\my \u0001pic.png',
      },
    ]
    expect(embeddedAttachments(specs)).toEqual([{ path: 'my pic.png', mime: 'image/png' }])
  })

  it('disambiguates resources whose titles claim the same vault path', () => {
    const first = '1a'.repeat(16)
    const second = '2b'.repeat(16)
    const third = '3c'.repeat(16)
    const fourth = '4d'.repeat(16)
    const png = { mime: 'image/png', file_extension: 'png' }
    const specs = [
      { id: first, fileName: `${first}.png`, meta: png, metaTitle: 'pic.png' },
      { id: second, fileName: `${second}.png`, meta: png, metaTitle: 'pic.png' },
      { id: third, fileName: `${third}.png`, meta: png, metaTitle: 'a.png' },
      { id: fourth, fileName: `${fourth}.png`, meta: png, metaTitle: 'a.png' },
    ]
    // The first claimant keeps the plain name; each later one gets a short
    // id prefix spliced in before the extension.
    expect(embeddedAttachments(specs).map((a) => a.path)).toEqual([
      'pic.png',
      `pic-${second.slice(0, 8)}.png`,
      'a.png',
      `a-${fourth.slice(0, 8)}.png`,
    ])
  })

  it('ships one attachment per distinct resource however often a note embeds it', () => {
    const first = '8a'.repeat(16)
    const second = '9b'.repeat(16)
    const noteId = 'ab'.repeat(16)
    const png = { mime: 'image/png', file_extension: 'png', type_: '4' }
    const archive = buildTar([
      itemMember(
        noteId,
        joplinItem(
          `Dupes\n\n![one](:/${first}) again ![encore](:/${first}) plus ![two](:/${second}).`,
          { id: noteId, parent_id: '', type_: '1' },
        ),
      ),
      itemMember(first, joplinItem('one.png', { id: first, ...png })),
      itemMember(second, joplinItem('two.png', { id: second, ...png })),
      { name: `resources/${first}.png`, data: HELLO_BYTES },
      { name: `resources/${second}.png`, data: HELLO_BYTES },
    ])
    const { notes } = parseJex(archive)
    expect(notes[0]?.attachments.map((a) => a.path)).toEqual(['one.png', 'two.png'])
    // Every reference is still rewritten — deduplication is of the shipped
    // bytes, not of the embeds.
    expect(notes[0]?.markdown).toBe(
      '![one](one.png) again ![encore](one.png) plus ![two](two.png).',
    )
  })
})

// --- Item and tar-header edge shapes ----------------------------------------

describe('parseJex malformed item and header shapes', () => {
  it('ends the metadata block at a line that is not `key: value`', () => {
    const noteId = 'cd'.repeat(16)
    // `NOCOLON` sits inside the trailing block but carries no colon, so the
    // metadata walk stops there and everything up to and including it is body.
    const text = `Title Line\n\nbody line\nNOCOLON\ntype_: 1\nid: ${noteId}\n`
    const { notes } = parseJex(buildTar([itemMember(noteId, text)]))
    expect(notes).toHaveLength(1)
    expect(notes[0]?.title).toBe('Title Line')
    expect(notes[0]?.markdown).toBe('body line\nNOCOLON')
  })

  it('imports a metadata-only item as an untitled, empty note', () => {
    const noteId = 'ef'.repeat(16)
    const text = `type_: 1\nid: ${noteId}\n`
    const { notes, skipped } = parseJex(buildTar([itemMember(noteId, text)]))
    expect(skipped).toBe(0)
    expect(notes).toEqual([
      {
        title: UNTITLED_PLACEHOLDER,
        markdown: '',
        createdMs: null,
        updatedMs: null,
        attachments: [],
      },
    ])
  })

  it('joins a USTAR `prefix` header field onto the member name', () => {
    const resourceId = '1f'.repeat(16)
    const noteId = '2f'.repeat(16)
    const archive = buildTar([
      itemMember(
        noteId,
        joplinItem(`Prefixed\n\n![pic](:/${resourceId})`, {
          id: noteId,
          parent_id: '',
          type_: '1',
        }),
      ),
      itemMember(
        resourceId,
        joplinItem('pic.png', {
          id: resourceId,
          mime: 'image/png',
          file_extension: 'png',
          type_: '4',
        }),
      ),
      // `resources/<id>.png` split across the USTAR name and prefix fields.
      { name: `${resourceId}.png`, prefix: 'resources', data: HELLO_BYTES },
    ])
    const { notes } = parseJex(archive)
    expect(notes[0]?.attachments.map((a) => a.path)).toEqual(['pic.png'])
    expect(notes[0]?.markdown).toBe('![pic](pic.png)')
  })

  it('reads a member stored with the contiguous-file type flag', () => {
    const noteId = '3f'.repeat(16)
    const item = itemMember(
      noteId,
      joplinItem('Contiguous', { id: noteId, parent_id: '', type_: '1' }),
    )
    const archive = buildTar([{ ...item, typeflag: 0x37 }])
    expect(parseJex(archive).notes.map((n) => n.title)).toEqual(['Contiguous'])
  })

  it('reads a member stored with the pre-USTAR NUL type flag', () => {
    const noteId = '4f'.repeat(16)
    const item = itemMember(
      noteId,
      joplinItem('Old Format', { id: noteId, parent_id: '', type_: '1' }),
    )
    const archive = buildTar([{ ...item, typeflag: 0x00 }])
    expect(parseJex(archive).notes.map((n) => n.title)).toEqual(['Old Format'])
  })
})

// --- Where the tar scan starts and stops ------------------------------------

/** A root-level note item member, optionally with a body under the title. */
function noteMember(id: string, title: string, body = ''): TarMember {
  const content = body.length > 0 ? `${title}\n\n${body}` : title
  return itemMember(id, joplinItem(content, { id, parent_id: '', type_: '1' }))
}

describe('parseJex tar scan boundaries', () => {
  it('stops at the end-of-archive marker and ignores what follows it', () => {
    // Two archives back to back: everything past the first one's zero blocks is
    // no longer a member, so a padded or appended-to `.jex` yields no phantoms.
    const real = buildTar([noteMember('a1'.repeat(16), 'Real Note')])
    const ghost = buildTar([noteMember('a2'.repeat(16), 'Ghost Note')])
    const archive = new Uint8Array(real.length + ghost.length)
    archive.set(real, 0)
    archive.set(ghost, real.length)
    const { notes, skipped } = parseJex(archive)
    expect(notes.map((n) => n.title)).toEqual(['Real Note'])
    expect(skipped).toBe(0)
  })

  it('imports a final member whose data ends on the last byte of the archive', () => {
    const last = 'b2'.repeat(16)
    const props = { id: last, parent_id: '', type_: '1' }
    // Pad the body so this member's data fills its 512-byte block exactly; with
    // the end-of-archive blocks cut away, its data ends at the final byte.
    const pad = 512 - joplinItem('Last\n\n', props).length
    expect(pad).toBeGreaterThan(0)
    const full = buildTar([
      noteMember('b1'.repeat(16), 'First'),
      itemMember(last, joplinItem(`Last\n\n${'x'.repeat(pad)}`, props)),
    ])
    const cutAtEndOfData = full.subarray(0, -1024)
    expect(parseJex(cutAtEndOfData).notes.map((n) => n.title)).toEqual(['First', 'Last'])
  })

  it('drops a member whose declared data runs past the end of the archive', () => {
    const full = buildTar([
      noteMember('c1'.repeat(16), 'First'),
      noteMember('c2'.repeat(16), 'Cut', 'x'.repeat(700)),
    ])
    // Header, data, header, then 100 of the second member's ~780 declared bytes:
    // a half-read item must not surface, as a note or as a skipped count.
    const { notes, skipped } = parseJex(full.subarray(0, 512 * 3 + 100))
    expect(notes.map((n) => n.title)).toEqual(['First'])
    expect(skipped).toBe(0)
  })

  it('does not read an extended-header record as an item', () => {
    // A pax/GNU extended header ('x') carries tar metadata, not file content.
    // Read as an item it parses as nothing, and a sound archive would report
    // itself damaged.
    const archive = buildTar([
      noteMember('d1'.repeat(16), 'Real Note'),
      {
        name: `${'d2'.repeat(16)}.md`,
        data: enc.encode('30 mtime=1700000000.0\n'),
        typeflag: 0x78,
      },
    ])
    const { notes, skipped } = parseJex(archive)
    expect(notes.map((n) => n.title)).toEqual(['Real Note'])
    expect(skipped).toBe(0)
  })
})

// --- Item text shapes --------------------------------------------------------

describe('parseJex item text shapes', () => {
  it('counts a `.md` member that is not a Joplin item as skipped', () => {
    const archive = buildTar([
      noteMember('e1'.repeat(16), 'Real Note'),
      itemMember('e2'.repeat(16), 'just some markdown, no metadata block\n'),
    ])
    const { notes, skipped } = parseJex(archive)
    expect(notes.map((n) => n.title)).toEqual(['Real Note'])
    expect(skipped).toBe(1)
  })

  it('parses an item whose file ends with a whitespace-only line', () => {
    const noteId = 'e3'.repeat(16)
    // Trailing blanks are dropped by trimmed value, not by emptiness: a final
    // line of spaces must not be mistaken for the metadata/content separator.
    const text = `${joplinItem('Trailing', { id: noteId, parent_id: '', type_: '1' })}   \n`
    const { notes, skipped } = parseJex(buildTar([itemMember(noteId, text)]))
    expect(skipped).toBe(0)
    expect(notes.map((n) => n.title)).toEqual(['Trailing'])
  })

  it('skips an item that is nothing but blank lines instead of spinning on it', () => {
    const { notes, skipped } = parseJex(buildTar([itemMember('e4'.repeat(16), '\n \n\n')]))
    expect(notes).toEqual([])
    expect(skipped).toBe(1)
  })

  it('trims the title line and the blank lines bracketing the body', () => {
    const noteId = 'e5'.repeat(16)
    const text = `  Spaced Title  \n   \nbody line  \n\ntype_: 1\nid: ${noteId}\n`
    const { notes } = parseJex(buildTar([itemMember(noteId, text)]))
    expect(notes[0]?.title).toBe('Spaced Title')
    expect(notes[0]?.markdown).toBe('body line')
  })

  it('prefers the user-facing timestamps over the sync ones', () => {
    // `created_time` is when the row appeared on this device; `user_created_time`
    // is the note's own age. Picking the former dates every synced note to the
    // day it synced.
    const noteId = 'e6'.repeat(16)
    const item = joplinItem('Timed', {
      id: noteId,
      parent_id: '',
      created_time: '2019-01-01T00:00:00.000Z',
      updated_time: '2019-02-02T00:00:00.000Z',
      user_created_time: '2021-01-02T03:04:05.000Z',
      user_updated_time: '2022-03-04T05:06:07.000Z',
      type_: '1',
    })
    const { notes } = parseJex(buildTar([itemMember(noteId, item)]))
    expect(notes[0]?.createdMs).toBe(Date.UTC(2021, 0, 2, 3, 4, 5))
    expect(notes[0]?.updatedMs).toBe(Date.UTC(2022, 2, 4, 5, 6, 7))
  })
})

// --- Notebook hierarchy → namespace path -------------------------------------

/** A notebook (`type_: 2`) item member titled `title`, under `parentId`. */
function folderMember(id: string, title: string, parentId = ''): TarMember {
  return itemMember(id, joplinItem(title, { id, parent_id: parentId, type_: '2' }))
}

/** A note item member filed under notebook `parentId`. */
function childNote(id: string, title: string, parentId: string): TarMember {
  return itemMember(id, joplinItem(title, { id, parent_id: parentId, type_: '1' }))
}

describe('parseJex notebook hierarchy', () => {
  it('nests notebooks into a namespace path, matching ids case-insensitively', () => {
    const parent = 'A1'.repeat(16)
    const child = 'B2'.repeat(16)
    const archive = buildTar([
      folderMember(parent, 'Parent'),
      folderMember(child, 'Child', parent),
      childNote('C3'.repeat(16), 'Deep', child),
    ])
    expect(parseJex(archive).notes.map((n) => n.title)).toEqual(['Parent/Child/Deep'])
  })

  it('leaves a note at the root when its notebook is missing from the archive', () => {
    const archive = buildTar([childNote('d4'.repeat(16), 'Orphan', 'e5'.repeat(16))])
    expect(parseJex(archive).notes.map((n) => n.title)).toEqual(['Orphan'])
  })

  it('collapses whitespace in a notebook title and skips an untitled notebook', () => {
    const outer = 'a4'.repeat(16)
    const inner = 'b5'.repeat(16)
    const archive = buildTar([
      folderMember(outer, 'My   Projects'),
      // Metadata only, so this notebook has no title line to contribute — and
      // must not contribute an empty namespace segment either.
      itemMember(inner, `id: ${inner}\nparent_id: ${outer}\ntype_: 2\n`),
      childNote('c6'.repeat(16), 'Nested', inner),
    ])
    expect(parseJex(archive).notes.map((n) => n.title)).toEqual(['My Projects/Nested'])
  })

  // The depth cap is not redundant with the `seen` set, which only stops
  // CYCLES: a long enough acyclic chain reaches it, and this is what pins where
  // it cuts. 65 notebooks deep, so the 65th is the one dropped.
  it('caps a deep acyclic notebook chain at 64 segments', () => {
    const id = (n: number) => n.toString(16).padStart(2, '0').repeat(16)
    const chain = Array.from({ length: 65 }, (_, i) =>
      folderMember(id(i), `N${i}`, i === 64 ? '' : id(i + 1)),
    )
    const archive = buildTar([...chain, childNote('cc'.repeat(16), 'Deep', id(0))])

    const [title] = parseJex(archive).notes.map((n) => n.title)
    const segments = (title ?? '').split('/')
    expect(segments).toHaveLength(65) // 64 notebooks + the note itself
    // Walked outermost-first, and N64 — the 65th — is the one the cap drops.
    expect(segments[0]).toBe('N63')
    expect(segments.at(-2)).toBe('N0')
    expect(segments.at(-1)).toBe('Deep')
  })

  it('walks a notebook cycle once instead of repeating it to the depth cap', () => {
    const alpha = 'a7'.repeat(16)
    const beta = 'b8'.repeat(16)
    const archive = buildTar([
      folderMember(alpha, 'Alpha', beta),
      folderMember(beta, 'Beta', alpha),
      childNote('c9'.repeat(16), 'Cycled', alpha),
    ])
    expect(parseJex(archive).notes.map((n) => n.title)).toEqual(['Beta/Alpha/Cycled'])
  })
})
