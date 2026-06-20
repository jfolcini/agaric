import { invoke } from '@tauri-apps/api/core'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { exportGraphAsZip } from '../export-graph'

vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { logger } from '../logger'

const mockedInvoke = vi.mocked(invoke)
const mockedLogger = vi.mocked(logger)

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

    const blob = await exportGraphAsZip(null)

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

    const blob = await exportGraphAsZip(null)
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

  it('splits a namespaced title into nested folders (#1446 Part A)', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_all_pages_in_space') {
        return [{ id: 'P1', content: 'Project/Backend/API' }]
      }
      if (cmd === 'export_page_markdown') return '# content'
      return null
    })

    const blob = await exportGraphAsZip(null)
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

    const blob = await exportGraphAsZip(null)
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

    const blob = await exportGraphAsZip(null)
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
        return [1, 2, 3]
      }
      return null
    })

    const blob = await exportGraphAsZip(null)
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

    const blob = await exportGraphAsZip(null)
    const unzipped = await JSZip.loadAsync(await blob.arrayBuffer())
    const md = await unzipped.file('Notes.md')?.async('string')
    // Unresolvable attachment → original ref preserved, nothing dropped.
    expect(md).toBe(`![x](attachment:${attId})`)
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      'export-graph',
      'inline attachment export failed',
      { attachmentId: attId },
      expect.any(Error),
    )
  })

  it('returns empty ZIP when no pages exist', async () => {
    mockedInvoke.mockResolvedValue([])

    const blob = await exportGraphAsZip(null)
    expect(blob).toBeInstanceOf(Blob)
  })

  it('skips and logs pages whose export fails, returning the rest', async () => {
    // Pin the partial-export contract (FE-M-12): a single per-page IPC failure
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

    const blob = await exportGraphAsZip(null)
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
})
