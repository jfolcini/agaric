/**
 * #6277 A4 — the palette's "Export page as Markdown" puts on the clipboard what
 * the page header's copy does: attachment refs resolved to filenames, never a
 * raw `attachment:<id>` link that opens nothing outside Agaric.
 */

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mockInvokeCommands, strictInvokeFallback } from '@/__tests__/helpers/invoke'
import { getPaletteCommand } from '@/hooks/palette-commands'
import { writeText } from '@/lib/clipboard'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/lib/clipboard', () => ({ writeText: vi.fn().mockResolvedValue(undefined) }))

const ATT_ID = '01HZX9P3QABCDEF0123456789'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(invoke).mockImplementation(
    mockInvokeCommands(
      {
        export_page_markdown: () => `See ![shot](attachment:${ATT_ID})`,
        read_attachment_meta: () => ({
          id: ATT_ID,
          block_id: 'B1',
          filename: 'shot.png',
          mime_type: 'image/png',
          size_bytes: 3,
          fs_path: 'x',
          created_at: 0,
          content_hash: null,
        }),
      },
      { fallback: strictInvokeFallback },
    ),
  )
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_1', title: 'Page one' }], label: '' }],
    activeTabIndex: 0,
  })
})

describe('palette export-page-markdown (#6277 A4)', () => {
  it('copies the page with its attachment refs resolved, as the page header does', async () => {
    getPaletteCommand('export-page-markdown')?.run({ onClose: vi.fn(), onEscalate: vi.fn() })

    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(vi.mocked(writeText).mock.calls[0]?.[0]).toBe('See ![shot](shot.png)')
  })
})
