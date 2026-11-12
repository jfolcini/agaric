/**
 * The page kebab's *Save as Markdown file* (#6546): it saves the Markdown
 * *Export as Markdown* copies as `<title>.md` through `downloadBlob`, and is
 * absent on Android, whose WebView saves no `blob:` download, and on a phone.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlockRow } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { PageHeader } from '@/components/pages/PageHeader'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useIsTouch } from '@/hooks/useIsTouch'
import type { ResolvedBlock } from '@/lib/bindings'
import { pageMarkdownForCopy } from '@/lib/export-graph'
import { t } from '@/lib/i18n'
import { __resetPlatformCacheForTests } from '@/lib/platform'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: vi.fn(() => false) }))

const PAGE_ID = '01HZY3V9Q8K2M4N6P7R8S9T0VW'
const ATTACHMENT_ID = '01HZX9P3QABCDEF0123456789'
// A namespace separator and characters no Windows file name may hold.
const TITLE = 'Work/Plans: Q3?'
const SPACE_ID = 'SPACE_PERSONAL'
const EMPTY_PAGE = { items: [], next_cursor: null, has_more: false, total_count: null }
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'

let pageStore: StoreApi<PageBlockState>
let exportPageMarkdown: () => string

// The anchor `downloadBlob` clicks, read at click time: what the webview saves.
let saved: { blob: Blob | undefined; download: string }[]
let createObjectURL: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore(PAGE_ID)
  useNavigationStore.setState({ currentView: 'page-editor', selectedBlockId: null })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [{ pageId: PAGE_ID, title: TITLE }], label: TITLE }],
    activeTabIndex: 0,
  })
  useSpaceStore.setState({
    currentSpaceId: SPACE_ID,
    availableSpaces: [{ id: SPACE_ID, name: 'Personal', accent_color: null }],
    isReady: true,
  })
  // An attachment ref, so the copy's rewrite shows in what is saved.
  exportPageMarkdown = () => `# ${TITLE}\n\n- see ![shot](attachment:${ATTACHMENT_ID})\n`
  vi.mocked(invoke).mockImplementation(
    mockInvokeCommands({
      list_tags_for_block: () => [],
      list_inherited_tags_for_block: () => [],
      list_all_tags_in_space: () => [],
      get_properties: () => [],
      list_property_defs: () => EMPTY_PAGE,
      get_page_aliases: () => [],
      query_by_property: () => EMPTY_PAGE,
      get_block: () => makeBlockRow({ id: PAGE_ID, block_type: 'page', content: TITLE }),
      record_page_open: () => null,
      batch_resolve: (): ResolvedBlock[] => [
        { id: PAGE_ID, title: TITLE, block_type: 'page', deleted: false },
      ],
      export_page_markdown: () => exportPageMarkdown(),
      read_attachment_meta: () => ({
        id: ATTACHMENT_ID,
        block_id: 'B1',
        filename: 'shot.png',
        mime_type: 'image/png',
        size_bytes: 3,
        fs_path: 'x',
        created_at: 0,
        content_hash: null,
      }),
    }),
  )
  saved = []
  let lastBlob: Blob | undefined
  createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    lastBlob = blob as Blob
    return 'blob:saved'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (this.getAttribute('href') === 'blob:saved') {
      saved.push({ blob: lastBlob, download: this.getAttribute('download') ?? '' })
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function renderHeader() {
  return render(
    <TooltipProvider>
      <PageBlockContext.Provider value={pageStore}>
        <PageHeader pageId={PAGE_ID} title={TITLE} />
      </PageBlockContext.Provider>
    </TooltipProvider>,
  )
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: t('pageHeader.pageActions') }))
  return screen.findByRole('menu', { name: t('pageHeader.pageActions') })
}

describe('PageHeader Save as Markdown file', () => {
  it('saves the Markdown the copy item copies, named after the sanitised title', async () => {
    const user = userEvent.setup()
    renderHeader()
    await openMenu(user)

    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.saveMarkdownFile') }))

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
    expect(saved[0]?.download).toBe('Work_Plans_ Q3_.md')
    const text = await saved[0]?.blob?.text()
    expect(text).toBe(await pageMarkdownForCopy(PAGE_ID))
    expect(text).toBe(`# ${TITLE}\n\n- see ![shot](shot.png)\n`)
    expect(vi.mocked(toast.success)).toHaveBeenCalledWith(
      t('pageHeader.markdownFileSaved', { fileName: 'Work_Plans_ Q3_.md' }),
    )
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: t('pageHeader.pageActions') })).toBeNull()
    })
  })

  it('shows an error toast and saves nothing when the export rejects', async () => {
    const user = userEvent.setup()
    exportPageMarkdown = () => {
      throw new Error('export failed')
    }
    renderHeader()
    await openMenu(user)

    await user.click(screen.getByRole('menuitem', { name: t('pageHeader.saveMarkdownFile') }))

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageHeader.markdownFileSaveFailed'))
    })
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(saved).toEqual([])
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  it('is reached by ArrowDown from Export as Markdown and runs on Enter', async () => {
    const user = userEvent.setup()
    renderHeader()
    await openMenu(user)
    const exportItem = screen.getByRole('menuitem', { name: /Export as Markdown/ })
    exportItem.focus()

    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: t('pageHeader.saveMarkdownFile') })).toHaveFocus()
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(saved).toHaveLength(1)
    })
  })

  it('has no a11y violations with the menu open', async () => {
    const user = userEvent.setup()
    renderHeader()
    const menu = await openMenu(user)
    screen.getByRole('menuitem', { name: t('pageHeader.saveMarkdownFile') })

    // The menu is portalled out of the render container, so audit it directly.
    await waitFor(async () => {
      expect(await axe(menu)).toHaveNoViolations()
    })
  })

  describe('in a phone-width window', () => {
    const desktopWidth = window.innerWidth
    beforeEach(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    })
    afterEach(() => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: desktopWidth })
      vi.mocked(useIsTouch).mockReturnValue(false)
    })

    it.each([true, false])('offers the row only without touch (touch: %s)', async (touch) => {
      vi.mocked(useIsTouch).mockReturnValue(touch)
      const user = userEvent.setup()
      renderHeader()
      await openMenu(user)

      expect(screen.getByRole('menuitem', { name: /Export as Markdown/ })).toBeInTheDocument()
      const row = screen.queryByRole('menuitem', { name: t('pageHeader.saveMarkdownFile') })
      expect(row === null).toBe(touch)
    })
  })

  describe('on Android', () => {
    beforeEach(() => {
      vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ANDROID_UA)
      __resetPlatformCacheForTests()
    })

    afterEach(() => {
      __resetPlatformCacheForTests()
    })

    it('leaves the row out of the menu', async () => {
      const user = userEvent.setup()
      renderHeader()
      await openMenu(user)

      expect(screen.getByRole('menuitem', { name: /Export as Markdown/ })).toBeInTheDocument()
      expect(
        screen.queryByRole('menuitem', { name: t('pageHeader.saveMarkdownFile') }),
      ).not.toBeInTheDocument()
    })
  })
})
