import { invoke } from '@tauri-apps/api/core'
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

    const blob = await exportGraphAsZip()

    expect(blob).toBeInstanceOf(Blob)
    expect(blob.size).toBeGreaterThan(0)
    // Verify export_page_markdown was called for each page
    const exportCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'export_page_markdown')
    expect(exportCalls).toHaveLength(2)
  })

  it('handles duplicate page names with ULID suffix', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') {
        return {
          items: [
            { id: 'P1', block_type: 'page', content: 'Same Name' },
            { id: 'P2', block_type: 'page', content: 'Same Name' },
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

    const blob = await exportGraphAsZip()
    expect(blob).toBeInstanceOf(Blob)
  })

  it('returns empty ZIP when no pages exist', async () => {
    mockedInvoke.mockResolvedValue({
      items: [],
      next_cursor: null,
      has_more: false,
    })

    const blob = await exportGraphAsZip()
    expect(blob).toBeInstanceOf(Blob)
  })
})
