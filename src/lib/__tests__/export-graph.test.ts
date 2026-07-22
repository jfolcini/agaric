import { invoke } from '@tauri-apps/api/core'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { exportGraphAsZip } from '@/lib/export-graph'

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '@/lib/logger'

const mockedInvoke = vi.mocked(invoke)
const mockedLogger = vi.mocked(logger)

// Canonical active-space ULID. `exportGraphAsZip` is required-active (b1):
// the page fetch only runs for an active space.
const SPACE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

beforeEach(() => {
  vi.clearAllMocks()
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

    const blob = await exportGraphAsZip(SPACE_ID)

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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const filenames = Object.keys(unzipped.files)

    // No emitted entry may contain a `..` traversal segment — the `..` parts are
    // neutralized to `Untitled`, keeping the archive contained.
    expect(filenames.every((f) => !f.split('/').includes('..'))).toBe(true)
    expect(filenames).toContain('Untitled/Untitled/etc/passwd.md')
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const md = await unzipped.file('Mixed.md')?.async('string')

    expect(md).toContain(`![shot](assets/${imgId}__shot.png)`)
    expect(md).toContain(`- [report.pdf](assets/${fileId}__report.pdf)`)
    expect(md).not.toContain('attachment:')
  })

  it('returns empty ZIP when no pages exist', async () => {
    mockedInvoke.mockResolvedValue([])

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(SPACE_ID)
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

    const blob = await exportGraphAsZip(null)

    expect(blob).toBeInstanceOf(Blob)
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_all_pages_in_space', expect.anything())
  })
})
