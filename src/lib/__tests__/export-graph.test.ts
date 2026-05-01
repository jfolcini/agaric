import { invoke } from '@tauri-apps/api/core'
import JSZip from 'jszip'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exportGraphAsZip } from '../export-graph'

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('exportGraphAsZip', () => {
  it('creates a ZIP blob with markdown files for each page', async () => {
    // Mock listBlocks to return 2 pages
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return {
          items: [
            { id: 'P1', block_type: 'page', content: 'My Notes' },
            { id: 'P2', block_type: 'page', content: 'Journal' },
          ],
          next_cursor: null,
          has_more: false,
        }
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
      if (cmd === 'list_blocks') {
        return {
          items: [
            { id: ulid1, block_type: 'page', content: 'Same Name' },
            { id: ulid2, block_type: 'page', content: 'Same Name' },
          ],
          next_cursor: null,
          has_more: false,
        }
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

  it('returns empty ZIP when no pages exist', async () => {
    mockedInvoke.mockResolvedValue({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const blob = await exportGraphAsZip(null)
    expect(blob).toBeInstanceOf(Blob)
  })
})
