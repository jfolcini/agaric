import { invoke } from '@tauri-apps/api/core'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  downloadBlob,
  exportAllSpacesAsZip,
  exportGraphAsZip,
  resolveAttachmentRefsForCopy,
  sanitizeSegment,
} from '@/lib/export-graph'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// #2969 — mocked so the ordering test below can observe when it fires
// relative to `export_page_markdown`; every other test gets a no-op
// resolved flush (reset in `beforeEach`) so existing assertions are
// unaffected.
vi.mock('@/lib/active-draft-flush', () => ({
  flushActiveDraft: vi.fn(),
}))

import { flushActiveDraft } from '@/lib/active-draft-flush'
import { logger } from '@/lib/logger'

const mockedInvoke = vi.mocked(invoke)
const mockedLogger = vi.mocked(logger)
const mockedFlushActiveDraft = vi.mocked(flushActiveDraft)

// Canonical active-space ULID. `exportGraphAsZip` is required-active (b1):
// the page fetch only runs for an active space.
const SPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

beforeEach(() => {
  vi.clearAllMocks()
  mockedFlushActiveDraft.mockResolvedValue(undefined)
})

describe('exportGraphAsZip', () => {
  it('creates a ZIP blob with markdown files for each page', async () => {
    // Mock list_all_pages_in_space to return 2 pages
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'My Notes' },
          { id: 'P2', content: 'Journal' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        return '# Test content'
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
    // Verify export_page_markdown was called for each page
    const exportCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'export_page_markdown')
    expect(exportCalls).toHaveLength(2)
  })

  it('handles duplicate page names with ULID suffix', async () => {
    // Use realistic 26-char Crockford-base32 ULIDs; the exporter slices the
    // first 8 chars onto the duplicate filename to disambiguate.
    const ulid1 = '01HZA1B2C3D4E5F6G7H8J9K0M1'
    const ulid2 = '01HZA9X8Y7W6V5T4S3R2Q1P0N9'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: ulid1, content: 'Same Name' },
          { id: ulid2, content: 'Same Name' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        return '# Content'
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    expect(blob).toBeInstanceOf(Blob)

    // Inspect the ZIP — a regression that collapsed duplicates into a single
    // overwritten entry must fail this test.
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)
    const sameNameMd = filenames.filter((f) => f.startsWith('Same Name') && f.endsWith('.md'))
    expect(sameNameMd).toHaveLength(2)
    // Two distinct entries — proves no overwrite/collision occurred.
    expect(new Set(sameNameMd).size).toBe(2)
    // At least one filename must carry a ULID-derived disambiguator suffix
    // (Crockford base32, excludes I/L/O/U). The exporter takes id.slice(0, 8).
    expect(sameNameMd.some((f) => /_[0-9A-HJKMNP-TV-Z]{8}\.md$/.test(f))).toBe(true)
  })

  it('re-checks the suffixed path so a 3-way same-millisecond collision never overwrites an entry (#2723)', async () => {
    // Three pages sharing a title, with ULIDs whose first 8 chars (the
    // timestamp component) are IDENTICAL — exactly what a bulk import's
    // single chunk transaction produces. Before #2723 the 3rd page's
    // id-suffixed candidate collided with the 2nd's and was never
    // re-checked, so `zip.file()` silently overwrote the 2nd entry.
    const ulid1 = '01HZA1B2C3AAAAAAAAAAAAAAAA'
    const ulid2 = '01HZA1B2C3BBBBBBBBBBBBBBBB'
    const ulid3 = '01HZA1B2C3CCCCCCCCCCCCCCCC'
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: ulid1, content: 'Same Name' },
          { id: ulid2, content: 'Same Name' },
          { id: ulid3, content: 'Same Name' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        return `# ${id}`
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)
    const sameNameMd = filenames.filter((f) => f.startsWith('Same Name') && f.endsWith('.md'))

    // All three pages must land as distinct entries — none silently dropped.
    expect(sameNameMd).toHaveLength(3)
    expect(new Set(sameNameMd).size).toBe(3)

    // Content round-trips correctly for every entry — proves no entry was
    // overwritten by a colliding path (the failure mode #2723 fixes).
    const contents = await Promise.all(sameNameMd.map((f) => unzipped.file(f)?.async('string')))
    expect(new Set(contents)).toEqual(new Set([`# ${ulid1}`, `# ${ulid2}`, `# ${ulid3}`]))
  })

  it('advances the collision counter UPWARD so a 4-way same-millisecond collision yields -2 then -3 (#2723)', async () => {
    // Four pages sharing a title AND the first 8 chars of their ULID, which is
    // what the disambiguation counter exists for: the id-suffixed candidate
    // `Same Name_01HZA1B2` is taken by page 2, so pages 3 and 4 fall through to
    // the `-<n>` counter. Pinning the EXACT emitted names (not just "4 distinct
    // entries") is what makes the counter's direction observable — a counter
    // that walked downward (2, 1, 0, …) would still produce four distinct
    // names, but they would be `-2` then `-1`, i.e. a suffix sequence that
    // marches toward and then past zero into negatives on a busier collision.
    const ulid1 = '01HZA1B2AAAAAAAAAAAAAAAAAA'
    const ulid2 = '01HZA1B2BBBBBBBBBBBBBBBBBB'
    const ulid3 = '01HZA1B2CCCCCCCCCCCCCCCCCC'
    const ulid4 = '01HZA1B2DDDDDDDDDDDDDDDDDD'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: ulid1, content: 'Dup' },
          { id: ulid2, content: 'Dup' },
          { id: ulid3, content: 'Dup' },
          { id: ulid4, content: 'Dup' },
        ]
      }
      if (cmd === 'export_page_markdown') return '# c'
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())

    expect(Object.keys(unzipped.files).toSorted()).toEqual([
      'Dup.md',
      'Dup_01HZA1B2-2.md',
      'Dup_01HZA1B2-3.md',
      'Dup_01HZA1B2.md',
    ])
  })

  it('tracks `seen` case-insensitively so `API` and `api` do not clash on extraction (#2723)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'API' },
          { id: 'P2', content: 'api' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        return `# ${id}`
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)
    const mdFiles = filenames.filter((f) => f.endsWith('.md'))

    // Two distinct entries whose lowercased names differ, so extraction on a
    // case-insensitive filesystem (Windows/macOS) can't clash them.
    expect(mdFiles).toHaveLength(2)
    const lowered = mdFiles.map((f) => f.toLowerCase())
    expect(new Set(lowered).size).toBe(2)
  })

  it('splits a namespaced title into nested folders (#1446 Part A)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Project/Backend/API' }]
      }
      if (cmd === 'export_page_markdown') return '# content'
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    // The namespace `/` must become nested folders, NOT the old flat `_`.
    expect(filenames).toContain('Project/Backend/API.md')
    expect(filenames).not.toContain('Project_Backend_API.md')
  })

  it('sanitizes illegal chars per segment but keeps the `/` separators', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        // A namespace whose segments carry genuinely-illegal filename chars.
        return [{ id: 'P1', content: 'Foo:bar/Baz?qux/A*PI' }]
      }
      if (cmd === 'export_page_markdown') return '# content'
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    // `:`, `?`, `*` sanitized to `_` within each segment; `/` preserved.
    expect(filenames).toContain('Foo_bar/Baz_qux/A_PI.md')
  })

  it('neutralizes path-traversal segments in a crafted title (#1446 Part A — Zip-Slip)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        // A malicious title attempting to escape the ZIP root on extraction.
        return [{ id: 'P1', content: '../../etc/passwd' }]
      }
      if (cmd === 'export_page_markdown') return '# content'
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    // No emitted entry may contain a `..` traversal segment — the `..` parts are
    // neutralized to `Untitled`, keeping the archive contained.
    expect(filenames.every((f) => !f.split('/').includes('..'))).toBe(true)
    expect(filenames).toContain('Untitled/Untitled/etc/passwd.md')
  })

  it('maps an absolute-looking title’s LEADING EMPTY segment to Untitled instead of dropping it', async () => {
    // `'/etc/x'.split('/')` yields a leading EMPTY segment, and `sanitizeSegment`
    // turns that into `'Untitled'` — so `titleToZipPath`'s `.filter(s => s.length > 0)`
    // never sees an empty string and drops nothing. Both doc comments in
    // `export-graph.ts` assert the opposite ("Empty segments … are dropped" /
    // "A leading empty segment (absolute `/etc/...`) is already dropped by the
    // caller's `filter`"), so pin what the code ACTUALLY does: a later "fix" that
    // made the filter live by returning `''` for an empty segment would silently
    // change `/etc/x.md`'s depth in the archive. The Zip-Slip test above does NOT
    // cover this — `../../etc/passwd` has no empty segment, it exercises the
    // dots-only branch of the sanitizer.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return [{ id: 'P1', content: '/etc/x' }]
      if (cmd === 'export_page_markdown') return '# content'
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())

    // The implicit directory entries are pinned too: they are what makes the
    // extra `Untitled/` level (i.e. the NOT-dropped empty segment) visible.
    expect(Object.keys(unzipped.files).toSorted()).toEqual([
      'Untitled/',
      'Untitled/etc/',
      'Untitled/etc/x.md',
    ])
  })

  it('emits inline-image attachment bytes and rewrites to a portable path (#1490)', async () => {
    const attId = '01HZX9P3QABCDEF0123456789'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Project/Notes' }]
      }
      if (cmd === 'export_page_markdown') {
        return `![shot](attachment:${attId})`
      }
      if (cmd === 'read_attachment_meta') {
        return {
          id: attId,
          block_id: 'B1',
          filename: 'shot.png',
          mime_type: 'image/png',
          size_bytes: 3,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      if (cmd === 'read_attachment') {
        // #2654: the real command returns a raw-byte `tauri::ipc::Response`,
        // which `invoke` resolves as an ArrayBuffer (not a JSON number[]).
        return new Uint8Array([1, 2, 3]).buffer
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    // The attachment bytes land under assets/, id-prefixed to avoid collisions.
    const assetName = `assets/${attId}__shot.png`
    expect(filenames).toContain(assetName)
    const assetFile = unzipped.file(assetName)
    expect(assetFile).not.toBeNull()
    const assetBytes = await assetFile?.async('uint8array')
    expect(assetBytes && Array.from(assetBytes)).toEqual([1, 2, 3])

    // The page (one folder deep) rewrites the ref to a relative portable path.
    const md = await unzipped.file('Project/Notes.md')?.async('string')
    expect(md).toBe(`![shot](../${assetName})`)
    expect(md).not.toContain('attachment:')
  })

  it('leaves an inline-image ref unchanged when its attachment cannot be read (#1490)', async () => {
    const attId = '01HZX9P3QABCDEF0123456789'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Notes' }]
      }
      if (cmd === 'export_page_markdown') return `![x](attachment:${attId})`
      if (cmd === 'read_attachment_meta') throw new Error('gone')
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const md = await unzipped.file('Notes.md')?.async('string')
    // Unresolvable attachment → original ref preserved, nothing dropped.
    expect(md).toBe(`![x](attachment:${attId})`)
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'export-graph',
      'attachment export failed',
      { attachmentId: attId },
      expect.any(Error),
    )
  })

  it('emits a block-scoped (non-inline) file attachment link and rewrites it, keeping it a plain link (#2961)', async () => {
    const attId = 'ATT_9'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Project/Notes' }]
      }
      if (cmd === 'export_page_markdown') {
        return `[report.pdf](attachment:${attId})`
      }
      if (cmd === 'read_attachment_meta') {
        return {
          id: attId,
          block_id: 'B1',
          filename: 'report.pdf',
          mime_type: 'application/pdf',
          size_bytes: 3,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      if (cmd === 'read_attachment') {
        return new Uint8Array([9, 8, 7]).buffer
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    // The attachment bytes land under assets/, id-prefixed to avoid collisions.
    const assetName = `assets/${attId}__report.pdf`
    expect(filenames).toContain(assetName)
    const assetFile = unzipped.file(assetName)
    expect(assetFile).not.toBeNull()
    const assetBytes = await assetFile?.async('uint8array')
    expect(assetBytes && Array.from(assetBytes)).toEqual([9, 8, 7])

    // The page (one folder deep) rewrites the ref to a relative portable path,
    // preserving it as a PLAIN link (no leading `!`) — not an image.
    const md = await unzipped.file('Project/Notes.md')?.async('string')
    expect(md).toBe(`[report.pdf](../${assetName})`)
    expect(md).not.toContain('attachment:')
    expect(md?.startsWith('!')).toBe(false)
  })

  it('collapses path separators in an attachment filename so the asset name cannot escape assets/ (#2961 Zip-Slip)', async () => {
    const attId = 'ATT_EVIL'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Notes' }]
      }
      if (cmd === 'export_page_markdown') return `[doc](attachment:${attId})`
      if (cmd === 'read_attachment_meta') {
        return {
          id: attId,
          block_id: 'B1',
          // A traversal-shaped filename (settable via rename_attachment).
          filename: '../../evil.sh',
          mime_type: 'text/x-sh',
          size_bytes: 1,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      if (cmd === 'read_attachment') return new Uint8Array([1]).buffer
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    // Every emitted entry stays inside assets/ (or is a page .md) — no entry
    // contains a `/../` traversal or starts with `..`.
    for (const name of filenames) {
      expect(name.includes('/../')).toBe(false)
      expect(name.startsWith('..')).toBe(false)
    }
    // The asset lands under assets/ with `/` collapsed to `_`.
    expect(filenames).toContain(`assets/${attId}__.._.._evil.sh`)
  })

  it('leaves a block-scoped file link unchanged when its attachment cannot be read (#2961)', async () => {
    const attId = 'ATT_GONE'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Notes' }]
      }
      if (cmd === 'export_page_markdown') return `[missing.pdf](attachment:${attId})`
      if (cmd === 'read_attachment_meta') throw new Error('gone')
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const md = await unzipped.file('Notes.md')?.async('string')
    // Unresolvable attachment → original ref preserved, nothing dropped.
    expect(md).toBe(`[missing.pdf](attachment:${attId})`)
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'export-graph',
      'attachment export failed',
      { attachmentId: attId },
      expect.any(Error),
    )
  })

  it('resolves both an inline image ref and a block-file link on the same page, keeping each form distinct (#2961)', async () => {
    const imgId = 'ATT_IMG'
    const fileId = 'ATT_FILE'
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Mixed' }]
      }
      if (cmd === 'export_page_markdown') {
        return `![shot](attachment:${imgId})\n\n- [report.pdf](attachment:${fileId})`
      }
      if (cmd === 'read_attachment_meta') {
        const id = (args as { attachmentId: string }).attachmentId
        return {
          id,
          block_id: 'B1',
          filename: id === imgId ? 'shot.png' : 'report.pdf',
          mime_type: id === imgId ? 'image/png' : 'application/pdf',
          size_bytes: 1,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      if (cmd === 'read_attachment') {
        return new Uint8Array([1]).buffer
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const md = await unzipped.file('Mixed.md')?.async('string')

    expect(md).toContain(`![shot](assets/${imgId}__shot.png)`)
    expect(md).toContain(`- [report.pdf](assets/${fileId}__report.pdf)`)
    expect(md).not.toContain('attachment:')
  })

  it('returns empty ZIP when no pages exist', async () => {
    mockedInvoke.mockResolvedValue([])

    const { blob } = await exportGraphAsZip(SPACE_ID)
    expect(blob).toBeInstanceOf(Blob)
  })

  it('skips and logs pages whose export fails, returning the rest', async () => {
    // Pin the partial-export contract: a single per-page IPC failure
    // must not reject the whole export. The successful pages still land in the
    // ZIP and the failure is surfaced through `logger.warn` with the page id.
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'Good One' },
          { id: 'P2', content: 'Broken' },
          { id: 'P3', content: 'Good Two' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        if (id === 'P2') throw new Error('boom')
        return `# ${id}`
      }
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    expect(filenames).toContain('Good One.md')
    expect(filenames).toContain('Good Two.md')
    expect(filenames).not.toContain('Broken.md')

    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'export-graph',
      'page export failed',
      { pageId: 'P2' },
      expect.any(Error),
    )
  })

  it('short-circuits to an empty ZIP with no active space, never calling list_all_pages_in_space (b1)', async () => {
    // b1 — the page fetch is required-active. With `spaceId == null` the
    // export must short-circuit to an empty page set (an empty but valid ZIP)
    // WITHOUT dispatching `list_all_pages_in_space` (a Global scope would be
    // rejected by the backend).
    mockedInvoke.mockResolvedValue([])

    const { blob } = await exportGraphAsZip(null)

    expect(blob).toBeInstanceOf(Blob)
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_all_pages_in_space', expect.anything())
  })

  it('reports a CLEAN empty result (no skips, no export-report.txt) with no active space (b1)', async () => {
    // The no-active-space short-circuit substitutes a hand-built empty
    // accumulation for the real per-space export. Its two entry lists must be
    // genuinely EMPTY, not merely present: a non-empty stand-in would be
    // reported to the caller as skipped work that never existed, and would
    // additionally cause an `export-report.txt` to be written into an
    // otherwise-empty ZIP.
    mockedInvoke.mockResolvedValue([])

    const result = await exportGraphAsZip(null)

    expect(result.exportedPages).toBe(0)
    expect(result.skippedPages).toBe(0)
    expect(result.skippedAttachments).toBe(0)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(unzipped.files)).toEqual([])
  })

  it('falls back to an Untitled path for a page with no content', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return [{ id: 'P1', content: null }]
      if (cmd === 'export_page_markdown') return '# untitled page'
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())

    expect(Object.keys(unzipped.files)).toEqual(['Untitled.md'])
  })

  it('reads a shared attachment ONCE even when several pages reference it (#1490 asset cache)', async () => {
    // `emittedAssets` is threaded across every page of a space precisely so a
    // logo referenced from 50 pages costs one `read_attachment` round-trip and
    // one ZIP entry, not 50 of each. Without the cache short-circuit the bytes
    // are re-fetched (and the same ZIP entry re-written) once per referencing
    // page.
    const attId = '01HZX9P3QABCDEF0123456789'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'One' },
          { id: 'P2', content: 'Two' },
          { id: 'P3', content: 'Three' },
        ]
      }
      if (cmd === 'export_page_markdown') return `![logo](attachment:${attId})`
      if (cmd === 'read_attachment_meta') {
        return {
          id: attId,
          block_id: 'B1',
          filename: 'logo.png',
          mime_type: 'image/png',
          size_bytes: 3,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      if (cmd === 'read_attachment') return new Uint8Array([1, 2, 3]).buffer
      return null
    })

    const { blob } = await exportGraphAsZip(SPACE_ID)

    const metaCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'read_attachment_meta')
    const byteCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'read_attachment')
    expect(metaCalls).toHaveLength(1)
    expect(byteCalls).toHaveLength(1)

    // …and all three pages still link to the one shared asset.
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const assetName = `assets/${attId}__logo.png`
    expect(Object.keys(unzipped.files)).toContain(assetName)
    for (const page of ['One.md', 'Two.md', 'Three.md']) {
      expect(await unzipped.file(page)?.async('string')).toBe(`![logo](${assetName})`)
    }
  })

  it('does not count a malformed ref alongside a valid one as a skipped attachment (#2965)', async () => {
    // A ref whose id fails the shape check is left verbatim in the ZIP's
    // markdown (a ZIP entry is inert — see `resolveAttachmentRefsForCopy` for
    // the clipboard path, which strips it instead). It is NOT an attachment
    // that "could not be read": there is no attachment. Counting it would
    // inflate `skippedAttachments` and fabricate an `export-report.txt` line
    // for an id that was never a real attachment id.
    //
    // The valid ref on the same page is load-bearing: with NO valid ref the
    // whole rewrite pass is short-circuited before the per-ref callback ever
    // sees the malformed one.
    const goodId = '01HZX9P3QABCDEF0123456789'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return [{ id: 'P1', content: 'Mixed' }]
      if (cmd === 'export_page_markdown') {
        return `![ok](attachment:${goodId})\n\n![bad](attachment:../../etc)`
      }
      if (cmd === 'read_attachment_meta') {
        return {
          id: goodId,
          block_id: 'B1',
          filename: 'ok.png',
          mime_type: 'image/png',
          size_bytes: 1,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      if (cmd === 'read_attachment') return new Uint8Array([7]).buffer
      return null
    })

    const result = await exportGraphAsZip(SPACE_ID)

    expect(result.exportedPages).toBe(1)
    expect(result.skippedAttachments).toBe(0)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(unzipped.file('export-report.txt')).toBeNull()
    const md = await unzipped.file('Mixed.md')?.async('string')
    expect(md).toBe(`![ok](assets/${goodId}__ok.png)\n\n![bad](attachment:../../etc)`)
  })

  // #2969 — the focused block's pending debounced content commit must be
  // flushed (and AWAITED) before any page markdown is read, so a just-typed
  // run of keystrokes (most notably via the Ctrl+Shift+E shortcut, which
  // never blurs the editor) isn't silently missing from the export.
  it('awaits flushActiveDraft before reading any page markdown (#2969)', async () => {
    const order: string[] = []
    mockedFlushActiveDraft.mockImplementation(async () => {
      order.push('flush')
    })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Notes' }]
      }
      if (cmd === 'export_page_markdown') {
        order.push('export')
        return '# content'
      }
      return null
    })

    await exportGraphAsZip(SPACE_ID)

    expect(order).toEqual(['flush', 'export'])
  })
})

describe('exportGraphAsZip skip accounting (#2965)', () => {
  it('counts a failed page export, writes export-report.txt naming it, and still returns the successful pages', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'Good' },
          { id: 'P2', content: 'Broken' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        if (id === 'P2') throw new Error('boom')
        return '# ok'
      }
      return null
    })

    const result = await exportGraphAsZip(SPACE_ID)

    expect(result.exportedPages).toBe(1)
    expect(result.skippedPages).toBe(1)
    expect(result.skippedAttachments).toBe(0)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(Object.keys(unzipped.files)).toContain('Good.md')
    const report = await unzipped.file('export-report.txt')?.async('string')
    expect(report).toBeDefined()
    expect(report).toContain('Skipped pages (1):')
    expect(report).toContain('Broken')
  })

  it('counts a failed attachment ONCE even when referenced from multiple pages, and lists it in export-report.txt', async () => {
    const attId = 'ATT_GONE'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'Page One' },
          { id: 'P2', content: 'Page Two' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        return `[missing](attachment:${attId})`
      }
      if (cmd === 'read_attachment_meta') throw new Error('gone')
      return null
    })

    const result = await exportGraphAsZip(SPACE_ID)

    expect(result.exportedPages).toBe(2)
    expect(result.skippedPages).toBe(0)
    // Same broken attachment referenced from both pages — distinct count, not
    // per-reference.
    expect(result.skippedAttachments).toBe(1)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const report = await unzipped.file('export-report.txt')?.async('string')
    expect(report).toBeDefined()
    expect(report).toContain('Skipped attachments (1):')
    expect(report).toContain(attId)
    expect(report).toContain('Page One.md')
  })

  it('omits export-report.txt and reports zero skips on the happy path (behavior unchanged)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Fine' }]
      }
      if (cmd === 'export_page_markdown') return '# fine'
      return null
    })

    const result = await exportGraphAsZip(SPACE_ID)

    expect(result.exportedPages).toBe(1)
    expect(result.skippedPages).toBe(0)
    expect(result.skippedAttachments).toBe(0)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(unzipped.file('export-report.txt')).toBeNull()
  })
})

// `export-report.txt` is the ONLY channel through which a user learns that
// part of their export silently went missing, and it is read by a human in a
// text editor after the fact — there is no UI around it to add context. Its
// wording and layout are therefore the artifact's whole contract, and the
// tests above only ever spot-checked it with `toContain`, which cannot see a
// blanked heading, a lost blank-line separator, a collapsed newline join, or
// a section header emitted for a section with nothing in it. These three
// pin the exact bytes for the three shapes the report can take.
const REPORT_PREAMBLE =
  'Agaric export report\n' +
  '\n' +
  'Some items could not be exported and were skipped. Everything else in\n' +
  'this ZIP exported normally.\n' +
  '\n'

describe('export-report.txt exact format (#2965)', () => {
  it('renders the pages-only report verbatim, with no empty attachments section', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'Good' },
          { id: 'P2', content: 'Broken One' },
          { id: 'P3', content: 'Broken Two' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        if (id !== 'P1') throw new Error('boom')
        return '# ok'
      }
      return null
    })

    const result = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())

    expect(await unzipped.file('export-report.txt')?.async('string')).toBe(
      `${REPORT_PREAMBLE}Skipped pages (2):\n  - Broken One\n  - Broken Two\n`,
    )
  })

  it('renders the attachments-only report verbatim, with no empty pages section', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') return [{ id: 'P1', content: 'Page One' }]
      if (cmd === 'export_page_markdown') return '[missing](attachment:ATT_GONE)'
      if (cmd === 'read_attachment_meta') throw new Error('gone')
      return null
    })

    const result = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())

    expect(await unzipped.file('export-report.txt')?.async('string')).toBe(
      `${REPORT_PREAMBLE}Skipped attachments (1):\n  - ATT_GONE (referenced in Page One.md)\n`,
    )
  })

  it('renders both sections verbatim, pages first, separated by a blank line', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_all_pages_in_space') {
        return [
          { id: 'P1', content: 'Alpha' },
          { id: 'P2', content: 'Beta' },
        ]
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        if (id === 'P2') throw new Error('boom')
        return '[doc](attachment:ATT_X)'
      }
      if (cmd === 'read_attachment_meta') throw new Error('gone')
      return null
    })

    const result = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())

    expect(await unzipped.file('export-report.txt')?.async('string')).toBe(
      `${REPORT_PREAMBLE}Skipped pages (1):\n  - Beta\n\nSkipped attachments (1):\n  - ATT_X (referenced in Alpha.md)\n`,
    )
  })
})

describe('exportAllSpacesAsZip (#2964)', () => {
  it('iterates every space and nests each one under its own top-level folder', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_spaces') {
        return [
          { id: 'SPACE_A', name: 'Personal', accent_color: null },
          { id: 'SPACE_B', name: 'Work', accent_color: null },
        ]
      }
      if (cmd === 'list_all_pages_in_space') {
        const scoped = (args as { scope: { space_id: string } }).scope.space_id
        if (scoped === 'SPACE_A') return [{ id: 'P1', content: 'Notes' }]
        if (scoped === 'SPACE_B') return [{ id: 'P2', content: 'Roadmap' }]
        return []
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        return `# ${id}`
      }
      return null
    })

    const result = await exportAllSpacesAsZip()

    expect(result.spaceCount).toBe(2)
    expect(result.exportedPages).toBe(2)
    expect(result.skippedPages).toBe(0)
    expect(result.skippedAttachments).toBe(0)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)
    expect(filenames).toContain('Personal/Notes.md')
    expect(filenames).toContain('Work/Roadmap.md')

    // Each space is scoped to its OWN page list — Work's folder never picks
    // up Personal's pages or vice versa.
    const personalMd = await unzipped.file('Personal/Notes.md')?.async('string')
    const workMd = await unzipped.file('Work/Roadmap.md')?.async('string')
    expect(personalMd).toBe('# P1')
    expect(workMd).toBe('# P2')
  })

  it('disambiguates two spaces whose names sanitize to the same folder name', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_spaces') {
        return [
          { id: 'SPACE_1AAAAAAA', name: 'Team', accent_color: null },
          { id: 'SPACE_2BBBBBBB', name: 'Team', accent_color: null },
        ]
      }
      if (cmd === 'list_all_pages_in_space') {
        const scoped = (args as { scope: { space_id: string } }).scope.space_id
        return [{ id: `P_${scoped}`, content: 'Notes' }]
      }
      if (cmd === 'export_page_markdown') return '# content'
      return null
    })

    const result = await exportAllSpacesAsZip()
    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const topLevelFolders = new Set(
      Object.keys(unzipped.files)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.split('/')[0] ?? ''),
    )

    // Two distinct folders — the second space's id-derived suffix
    // disambiguates it from the first, same scheme as duplicate page titles.
    expect(topLevelFolders.size).toBe(2)
    expect(topLevelFolders).toContain('Team')
    expect([...topLevelFolders].some((f) => f !== 'Team' && f.startsWith('Team_'))).toBe(true)
  })

  it('handles the zero-spaces case without producing a silent empty ZIP', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces') return []
      return null
    })

    const result = await exportAllSpacesAsZip()

    expect(result.spaceCount).toBe(0)
    expect(result.exportedPages).toBe(0)
    expect(result.blob).toBeInstanceOf(Blob)
    // No per-space page fetch is ever dispatched when there are no spaces.
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_all_pages_in_space', expect.anything())
  })

  it('sums skipped pages/attachments across spaces and writes one combined export-report.txt', async () => {
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'list_spaces') {
        return [
          { id: 'SPACE_A', name: 'Personal', accent_color: null },
          { id: 'SPACE_B', name: 'Work', accent_color: null },
        ]
      }
      if (cmd === 'list_all_pages_in_space') {
        const scoped = (args as { scope: { space_id: string } }).scope.space_id
        if (scoped === 'SPACE_A') return [{ id: 'PA_OK', content: 'Good' }]
        if (scoped === 'SPACE_B') return [{ id: 'PB_BAD', content: 'Broken' }]
        return []
      }
      if (cmd === 'export_page_markdown') {
        const id = (args as { pageId: string }).pageId
        if (id === 'PB_BAD') throw new Error('boom')
        return '# ok'
      }
      return null
    })

    const result = await exportAllSpacesAsZip()

    expect(result.exportedPages).toBe(1)
    expect(result.skippedPages).toBe(1)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    const report = await unzipped.file('export-report.txt')?.async('string')
    expect(report).toBeDefined()
    expect(report).toContain('Broken')
  })

  it('awaits flushActiveDraft before reading any space or page (#2969 parity)', async () => {
    const order: string[] = []
    mockedFlushActiveDraft.mockImplementation(async () => {
      order.push('flush')
    })
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces') {
        order.push('list_spaces')
        return [{ id: 'SPACE_A', name: 'Personal', accent_color: null }]
      }
      if (cmd === 'list_all_pages_in_space') return []
      return null
    })

    await exportAllSpacesAsZip()

    expect(order).toEqual(['flush', 'list_spaces'])
  })

  it('flattens a `/` in a space name to `_` instead of nesting the space folder', async () => {
    // Unlike a page title, a space name is NOT namespaced, so a literal `/` in
    // it is part of the name — nesting on it would scatter one space's pages
    // under a folder shared with any other space whose name starts the same
    // way, and would break the "one top-level folder per space" contract.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces') {
        return [{ id: 'SPACE_A', name: 'Team/Docs', accent_color: null }]
      }
      if (cmd === 'list_all_pages_in_space') return [{ id: 'P1', content: 'Notes' }]
      if (cmd === 'export_page_markdown') return '# c'
      return null
    })

    const result = await exportAllSpacesAsZip()
    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())

    expect(Object.keys(unzipped.files)).toContain('Team_Docs/Notes.md')
  })

  it('omits export-report.txt entirely when every space exports cleanly', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces') {
        return [
          { id: 'SPACE_A', name: 'Personal', accent_color: null },
          { id: 'SPACE_B', name: 'Work', accent_color: null },
        ]
      }
      if (cmd === 'list_all_pages_in_space') return [{ id: 'P1', content: 'Notes' }]
      if (cmd === 'export_page_markdown') return '# c'
      return null
    })

    const result = await exportAllSpacesAsZip()

    expect(result.skippedPages).toBe(0)
    expect(result.skippedAttachments).toBe(0)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    // A skip ledger in a ZIP where nothing was skipped is worse than no
    // ledger: it tells the user their export is incomplete when it is not.
    expect(unzipped.file('export-report.txt')).toBeNull()
  })

  it('writes export-report.txt when ONLY attachments were skipped (no page failed)', async () => {
    // The all-spaces report trigger is a disjunction, and this is the arm that
    // a pages-only fixture can never exercise: every page exports fine, yet an
    // attachment inside one of them could not be read.
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_spaces') {
        return [{ id: 'SPACE_A', name: 'Personal', accent_color: null }]
      }
      if (cmd === 'list_all_pages_in_space') return [{ id: 'P1', content: 'Notes' }]
      if (cmd === 'export_page_markdown') return '[missing](attachment:ATT_GONE)'
      if (cmd === 'read_attachment_meta') throw new Error('gone')
      return null
    })

    const result = await exportAllSpacesAsZip()

    expect(result.exportedPages).toBe(1)
    expect(result.skippedPages).toBe(0)
    expect(result.skippedAttachments).toBe(1)

    const unzipped = await JSZip.loadAsync(await result.blob.arrayBuffer())
    expect(await unzipped.file('export-report.txt')?.async('string')).toBe(
      `${REPORT_PREAMBLE}Skipped attachments (1):\n  - ATT_GONE (referenced in Personal/Notes.md)\n`,
    )
  })
})

describe('sanitizeSegment', () => {
  it('leaves an ordinary segment name unchanged', () => {
    expect(sanitizeSegment('My Notes')).toBe('My Notes')
  })

  it('still strips illegal-per-segment characters (existing Zip-Slip/illegal-char behavior unchanged)', () => {
    expect(sanitizeSegment('Foo:bar?baz*qux')).toBe('Foo_bar_baz_qux')
  })

  it('still neutralizes a dots-only segment to Untitled (Zip-Slip guard unchanged)', () => {
    expect(sanitizeSegment('..')).toBe('Untitled')
    expect(sanitizeSegment('...')).toBe('Untitled')
  })

  it('still falls back to Untitled for an empty/whitespace-only segment', () => {
    expect(sanitizeSegment('')).toBe('Untitled')
    expect(sanitizeSegment('   ')).toBe('Untitled')
  })

  // #2966 — Windows reserved device names, case-insensitive, with or without extension.
  it.each([
    ['CON', 'CON_'],
    ['con', 'con_'],
    ['PRN', 'PRN_'],
    ['AUX', 'AUX_'],
    ['NUL', 'NUL_'],
    ['nul', 'nul_'],
    ['COM1', 'COM1_'],
    ['com9', 'com9_'],
    ['LPT1', 'LPT1_'],
    ['lpt9', 'lpt9_'],
    ['CON.txt', 'CON_.txt'],
    ['nul.md', 'nul_.md'],
    ['Com3.TAR.GZ', 'Com3_.TAR.GZ'],
  ])('escapes reserved device name %s -> %s', (input, expected) => {
    expect(sanitizeSegment(input)).toBe(expected)
  })

  it('does not escape a name that merely starts with a reserved token', () => {
    // `CONtent`/`comrade` are not reserved — only an EXACT basename match is.
    expect(sanitizeSegment('CONtent')).toBe('CONtent')
    expect(sanitizeSegment('comrade.txt')).toBe('comrade.txt')
    expect(sanitizeSegment('LPT10')).toBe('LPT10')
    expect(sanitizeSegment('COM0')).toBe('COM0')
  })

  // #2966 — trailing dots/spaces, which Windows silently strips on write.
  it('trims trailing dots and spaces', () => {
    expect(sanitizeSegment('Notes.')).toBe('Notes')
    expect(sanitizeSegment('Notes ')).toBe('Notes')
    expect(sanitizeSegment('Notes...')).toBe('Notes')
    expect(sanitizeSegment('Notes. . .')).toBe('Notes')
  })

  it('falls back to Untitled when trailing-dot/space trimming empties the segment', () => {
    expect(sanitizeSegment('. . .')).toBe('Untitled')
  })

  it('combines trailing-dot trimming with reserved-name escaping', () => {
    expect(sanitizeSegment('CON...')).toBe('CON_')
    expect(sanitizeSegment('CON ')).toBe('CON_')
  })

  it('does not escape a name that merely ENDS with a reserved token', () => {
    // The reserved-name test is anchored at BOTH ends: only an exact basename
    // match is reserved on Windows. `BACON` / `bacon.txt` end with `CON` but
    // are perfectly legal filenames — escaping them would mangle ordinary
    // titles. (The `starts with` half is pinned by the test above; this pins
    // the other half of the same anchor, so neither `^` nor `$` can be
    // dropped from `RESERVED_DEVICE_NAME_RE` unnoticed.)
    expect(sanitizeSegment('BACON')).toBe('BACON')
    expect(sanitizeSegment('bacon.txt')).toBe('bacon.txt')
    expect(sanitizeSegment('SITCOM1')).toBe('SITCOM1')
  })

  it('escapes a reserved basename whose trailing space is INSIDE the name (before the extension)', () => {
    // `CON .txt` keeps its space mid-string, so the segment-level
    // trailing-dot/space trim (which only looks at the very end) leaves it
    // alone. Windows still strips the space when resolving the basename, so
    // `CON .txt` resolves to the reserved `CON` device — the escape must
    // therefore test the basename with its TRAILING whitespace removed.
    expect(sanitizeSegment('CON .txt')).toBe('CON _.txt')
    expect(sanitizeSegment('nul  .md')).toBe('nul  _.md')
  })

  it('trims LEADING whitespace as well as trailing', () => {
    // The trailing-only `[. ]+$` pass later in the function cannot remove a
    // leading run, so the initial `.trim()` is what keeps `  Notes  ` from
    // becoming a ZIP entry whose name starts with spaces.
    expect(sanitizeSegment('  Notes  ')).toBe('Notes')
    expect(sanitizeSegment('\tTabbed')).toBe('Tabbed')
  })
})

describe('resolveAttachmentRefsForCopy (#2967)', () => {
  it('returns markdown unchanged when it has no attachment refs', async () => {
    const md = '# Just text\n\nNo images here.'
    expect(await resolveAttachmentRefsForCopy(md)).toBe(md)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('rewrites an inline-image ref to the attachment filename, dropping the dead scheme', async () => {
    const attId = '01HZX9P3QABCDEF0123456789'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_attachment_meta') {
        return {
          id: attId,
          block_id: 'B1',
          filename: 'shot.png',
          mime_type: 'image/png',
          size_bytes: 3,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      return null
    })

    const md = `![shot](attachment:${attId})`
    const result = await resolveAttachmentRefsForCopy(md)

    expect(result).toBe('![shot](shot.png)')
    expect(result).not.toContain('attachment:')
  })

  it('rewrites a block-scoped file link to the attachment filename, keeping it a plain link', async () => {
    const attId = 'ATT_9'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_attachment_meta') {
        return {
          id: attId,
          block_id: 'B1',
          filename: 'report.pdf',
          mime_type: 'application/pdf',
          size_bytes: 3,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      return null
    })

    const md = `[report.pdf](attachment:${attId})`
    const result = await resolveAttachmentRefsForCopy(md)

    expect(result).toBe('[report.pdf](report.pdf)')
    expect(result).not.toContain('attachment:')
    expect(result.startsWith('!')).toBe(false)
  })

  it('flattens a path separator in a hostile attachment filename', async () => {
    const attId = 'ATT_EVIL'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_attachment_meta') {
        return {
          id: attId,
          block_id: 'B1',
          filename: '../../evil.sh',
          mime_type: 'text/x-sh',
          size_bytes: 1,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      return null
    })

    const md = `[doc](attachment:${attId})`
    const result = await resolveAttachmentRefsForCopy(md)

    expect(result).toBe('[doc](.._.._evil.sh)')
    expect(result).not.toContain('/')
  })

  it('strips a ref down to bare alt/label text (no dead scheme) when the attachment cannot be resolved', async () => {
    const attId = '01HZX9P3QABCDEF0123456789'
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'read_attachment_meta') throw new Error('gone')
      return null
    })

    const md = `![x](attachment:${attId})`
    const result = await resolveAttachmentRefsForCopy(md)

    expect(result).toBe('x')
    expect(result).not.toContain('attachment:')
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'export-graph',
      'attachment resolve failed',
      { attachmentId: attId },
      expect.any(Error),
    )
  })

  it('strips a malformed/hostile ref (fails the id-shape check) to bare alt text instead of leaving the dead scheme', async () => {
    // `../../etc` matches the loose outer regex (no `)`/whitespace) but fails
    // `ATTACHMENT_ID_PATTERN`, so `parseAttachmentRef` returns null and this
    // id never reaches `readAttachmentMeta` at all — the invariant must still
    // hold via the `id == null` branch, not via a resolved lookup.
    const md = '![alt](attachment:../../etc)'
    const result = await resolveAttachmentRefsForCopy(md)

    expect(result).toBe('alt')
    expect(result).not.toContain('attachment:')
    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('resolves multiple distinct refs on the same page independently', async () => {
    const imgId = 'ATT_IMG'
    const fileId = 'ATT_FILE'
    mockedInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'read_attachment_meta') {
        const id = (args as { attachmentId: string }).attachmentId
        return {
          id,
          block_id: 'B1',
          filename: id === imgId ? 'shot.png' : 'report.pdf',
          mime_type: id === imgId ? 'image/png' : 'application/pdf',
          size_bytes: 1,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }
      }
      return null
    })

    const md = `![shot](attachment:${imgId})\n\n- [report.pdf](attachment:${fileId})`
    const result = await resolveAttachmentRefsForCopy(md)

    expect(result).toContain('![shot](shot.png)')
    expect(result).toContain('- [report.pdf](report.pdf)')
    expect(result).not.toContain('attachment:')
  })
})

describe('downloadBlob', () => {
  it('clicks a temporary anchor while attached, then detaches it and revokes the object URL', () => {
    // The last mile of every export: without this the ZIP is built and thrown
    // away. Each step is load-bearing — a click on a DETACHED anchor is a
    // no-op in Chromium, a non-anchor element has no `download` behavior at
    // all, and a leaked object URL pins the whole blob in memory for the
    // lifetime of the document.
    const objectUrl = 'blob:agaric/test-object-url'
    const createObjectURL = vi.fn(() => objectUrl)
    const revokeObjectURL = vi.fn()
    // `vi.stubGlobal` (not a direct assign-and-restore) because happy-dom may
    // not define these on `URL` at all — a plain restore would then write
    // `undefined` back onto the property instead of removing it, an
    // asymmetric restore that leaks into later tests. `vi.stubGlobal` snapshots
    // the real property descriptor (present or absent) and `unstubAllGlobals`
    // reinstates it exactly, deleting the property again if it was never there.
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })

    // Snapshot the anchor's state AT CLICK TIME — afterwards it is detached
    // again, so `attached` can only be observed from inside the click.
    const clicks: { tag: string; href: string; download: string; attached: boolean }[] = []
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push({
          tag: this.tagName,
          href: this.getAttribute('href') ?? '',
          download: this.getAttribute('download') ?? '',
          attached: document.body.contains(this),
        })
      })

    try {
      const blob = new Blob(['zip bytes'])

      downloadBlob(blob, 'agaric-export.zip')

      expect(createObjectURL).toHaveBeenCalledWith(blob)
      expect(clicks).toEqual([
        { tag: 'A', href: objectUrl, download: 'agaric-export.zip', attached: true },
      ])
      expect(document.body.querySelector('a')).toBeNull()
      expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl)
    } finally {
      clickSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})

/*
 * ---------------------------------------------------------------------------
 * EQUIVALENT-MUTANT LEDGER — src/lib/export-graph.ts (#3753)
 * ---------------------------------------------------------------------------
 * Mutants below survive the Stryker run and CANNOT be killed: each provably
 * produces output identical to the original for every input. Recorded here so
 * the next triage pass does not re-derive them. Format: line:col [mutator]
 * verbatim replacement → argument.
 *
 * Two structural lemmas do most of the work:
 *
 *   L1. `sanitizeSegment` NEVER returns an empty/falsy string. Its three exits
 *       are `'Untitled'` (line 89), `'Untitled'` (line 92) and
 *       `escapeReservedDeviceName(cleaned)` (line 94) — and line 92 guarantees
 *       `cleaned.length > 0` before that last one, while
 *       `escapeReservedDeviceName` returns either its own (non-empty) argument
 *       or `` `${basename}_${rest}` `` (≥ 1 char). Note the third exit is safe
 *       for EVERY argument, including `.`-leading ones: `'.md'` gives
 *       `basename === ''`, which is not reserved, so the input is returned
 *       unchanged rather than collapsing. This is a proof by enumeration of the
 *       exits, not a sampling result — no input can evade it.
 *
 *   L2. Therefore, in `titleToZipPath`, `segments.length === title.split('/').length`
 *       always — `split` returns ≥ 1 element, `map` preserves length, and the
 *       `.filter(s => s.length > 0)` can never drop anything (L1). So
 *       `segments.length > 0` is invariantly TRUE and `.filter` is a no-op.
 *       L2 is a DEDUCTIVE consequence of L1, not an empirical one: reaching
 *       `segments.length === 0` requires the filter to drop every segment, which
 *       is precisely what L1 forbids. So no amount of sampling can corroborate
 *       L2 independently — if L1 holds, L2 holds; if L1 ever failed, a sweep
 *       that never observed `length === 0` would prove nothing.
 *
 * The sweep harness was validated against all 44 mutants Stryker KILLED in
 * lines 48-111: every one of them showed a difference (0 blind spots), so its
 * null results below are meaningful.
 *
 *  89:7  [ConditionalExpression] "false"
 *  89:7  [LogicalOperator]       "cleaned.length === 0 && /^\.+$/.test(cleaned)"
 *  89:7  [ConditionalExpression] "false"   (the `cleaned.length === 0` operand)
 *  89:31 [Regex]                 "/^\.$/"
 *      All four weaken or delete the `cleaned.length === 0 || /^\.+$/` guard,
 *      and all four are subsumed by lines 91-92: `cleaned.replace(/[. ]+$/, '')`
 *      erases a dots-only string entirely, and the `cleaned.length === 0`
 *      re-check two lines later then returns the same `'Untitled'` the guard
 *      would have returned. (For the `&&` variant specifically: it can never
 *      fire at all, since `/^\.+$/.test('')` is false — an empty string has no
 *      dots — so it degenerates to the deleted-guard case.) Line 89 is thus
 *      REDUNDANT with 91-92. It is kept deliberately as an explicit,
 *      documented Zip-Slip guard rather than relying on a coincidence of the
 *      trailing-trim regex — see the CODE FINDINGS note at the end.
 *
 * 106:20 [MethodExpression]      "title.split('/').map(s => sanitizeSegment(s))"
 * 109:20 [ConditionalExpression] "true"
 * 109:20 [EqualityOperator]      "s.length >= 0"
 *      All three neutralize the `.filter(s => s.length > 0)`, which is dead by
 *      L2. Zero differences over 16,119 inputs.
 *
 * 110:10 [ConditionalExpression] "true"
 * 110:10 [EqualityOperator]      "segments.length >= 0"
 * 110:53 [StringLiteral]         "\"\""   (NoCoverage — the `: 'Untitled'` arm)
 *      `segments.length > 0` is invariantly true by L2, so the ternary always
 *      takes the `join` arm and its else-branch is unreachable; mutating the
 *      condition to another always-true form, or mutating the dead arm's
 *      string, changes nothing.
 *
 * 301:65 [StringLiteral] "\"\""  (NoCoverage — `page.content ?? 'Untitled'`)
 *      Only reachable when a page has no content, and then
 *      `titleToZipPath('Untitled')` and `titleToZipPath('')` both return
 *      `'Untitled'` (the empty title splits to `['']`, which `sanitizeSegment`
 *      maps to `'Untitled'`). The `Untitled.md` path is now pinned by the
 *      "falls back to an Untitled path for a page with no content" test above,
 *      which converts this from NoCoverage to covered-but-equivalent.
 *
 * 466:43 [StringLiteral] "\"Stryker was here!\""  (NoCoverage — `m[3] ?? ''`)
 *      Capture group 3 of `ATTACHMENT_REF_RE` is neither optional nor inside an
 *      alternation, so it always participates in a successful match and `m[3]`
 *      is always a string — the `?? ''` arm is unreachable. Checked over 636
 *      real matches from 1,008 ref-shaped inputs: group 3 was nullish 0 times.
 *
 * 504:22 [StringLiteral] "\"Stryker was here!\""  (NoCoverage)
 *      The `assetsPathPrefix = ''` DEFAULT parameter of `rewriteAttachmentRefs`.
 *      The function has exactly one call site (line 307) and it always passes
 *      the argument explicitly, so the default is never evaluated.
 *
 * 507:7  [ConditionalExpression] "false"  (`if (ids.size === 0) return …`)
 *      A pure fast path. When `ids` is empty, every ref the regex finds must
 *      have failed `parseAttachmentRef` (that is exactly why it is not in
 *      `ids`), so the rewrite callback hits `if (id == null) return match` for
 *      every match and `String.replace` reproduces the input string verbatim;
 *      the emit loop runs zero iterations and `skippedAttachmentIds` stays
 *      empty. Both branches therefore return `{ md, skippedAttachmentIds: [] }`
 *      with identical values.
 *
 * 529:53 [StringLiteral] "\"\""  (NoCoverage — `sanitizeSegment(flatName) || 'attachment'`)
 *      Unreachable by L1: `sanitizeSegment` never returns a falsy value, so the
 *      `||` right operand is never evaluated.
 *
 * 597:7  [ConditionalExpression] "false"  (`if (!md.includes(ATTACHMENT_REF_SCHEME)) return md`)
 *      Another pure fast path. `ATTACHMENT_REF_SCHEME` is the literal
 *      `'attachment:'`, which appears verbatim inside `ATTACHMENT_REF_RE`, so a
 *      string lacking the substring cannot match the regex: `collectAttachmentIds`
 *      returns an empty set and `md.replace` with no matches returns the input
 *      string. Verified over 11,111 scheme-free generated inputs: 0 matches.
 *
 * 617:9  [ConditionalExpression] "false"  (`if (id == null) return alt`)
 *      Falling through is indistinguishable: `resolved`'s keys all come from
 *      `parseAttachmentRef` and are therefore non-null strings, so
 *      `resolved.get(null)` is `undefined`, and the very next line's
 *      `filename == null ? alt : …` returns the same `alt` the guard would
 *      have. Note this is NOT dead code in the defensive sense — it is the
 *      documented "malformed ref is stripped to bare text" contract, pinned by
 *      the "strips a malformed/hostile ref" test above; the two paths simply
 *      converge on the same value.
 *
 * ---------------------------------------------------------------------------
 * CODE FINDINGS (follow-up material, no behavior change made here)
 * ---------------------------------------------------------------------------
 * 1. `titleToZipPath`'s `.filter((s) => s.length > 0)` and its
 *    `segments.length > 0 ? … : 'Untitled'` ternary are both DEAD (L2). Worse,
 *    two doc comments assert the opposite: `titleToZipPath`'s says "Empty
 *    segments (leading/trailing or doubled slashes) are dropped" and
 *    `sanitizeSegment`'s says "A leading empty segment (absolute `/etc/...`) is
 *    already dropped by the caller's `filter`". Neither is true — an empty
 *    segment becomes `'Untitled'` before the filter ever sees it, so `'/etc/x'`
 *    exports as `Untitled/etc/x.md` — confirmed by running it, and now pinned by
 *    the "maps an absolute-looking title's LEADING EMPTY segment to Untitled"
 *    test above. (The `../../etc/passwd` Zip-Slip test does NOT cover this: that
 *    title has no empty segment, it exercises the dots-only branch.) The
 *    behavior is safe; the docs are wrong.
 * 2. Line 89's traversal guard is subsumed by the trailing-dot trim on lines
 *    91-92 for ALL inputs, not merely the tested ones — the argument is total,
 *    not empirical: line 89 fires iff `cleaned` is `''` or matches `/^\.+$/`,
 *    and in BOTH of those cases `cleaned.replace(/[. ]+$/, '')` erases the whole
 *    string (a string of only dots is matched end-to-end by `[. ]+$`), so line
 *    92 returns the identical `'Untitled'`. There is no input for which the two
 *    paths differ. Keeping line 89 is defensible as explicit security intent,
 *    but it is belt-and-braces, not load-bearing.
 * 3. `rewriteAttachmentRefs`'s `assetsPathPrefix = ''` default (504) and
 *    `collectAttachmentIds`'s `m[3] ?? ''` (466) are both unreachable defensive
 *    code, as is the `|| 'attachment'` fallback on 529.
 */
