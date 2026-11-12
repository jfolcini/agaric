/**
 * The page kebab's *Copy app link* (#6555): it writes the open page's
 * `agaric://page/<ULID>` link, the one the deep-link router opens.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { makeBlockRow } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { PageHeader } from '@/components/pages/PageHeader'
import { TooltipProvider } from '@/components/ui/tooltip'
import { dispatchLaunchUrl } from '@/hooks/useDeepLinkRouter'
import type { ResolvedBlock } from '@/lib/bindings'
import { writeText } from '@/lib/clipboard'
import { t } from '@/lib/i18n'
import { useNavigationStore } from '@/stores/navigation'
import { createPageBlockStore, PageBlockContext, type PageBlockState } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'

// Mocked here, not through the plugin stub, so a rejection reaches the caller:
// `writeText` falls back to `navigator.clipboard` when the plugin fails.
vi.mock('@/lib/clipboard', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}))

const PAGE_ID = '01HZY3V9Q8K2M4N6P7R8S9T0VW'
const OTHER_PAGE_ID = '01HZY3V9Q8K2M4N6P7R8S9T0VX'
const TITLE = 'Reading list'
const SPACE_ID = 'SPACE_PERSONAL'
const EMPTY_PAGE = { items: [], next_cursor: null, has_more: false, total_count: null }

const mockedWriteText = vi.mocked(writeText)
let pageStore: StoreApi<PageBlockState>

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore(PAGE_ID)
  mockedWriteText.mockResolvedValue(undefined)
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
    }),
  )
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

async function copyAppLink(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: t('pageHeader.pageActions') }))
  await user.click(await screen.findByRole('menuitem', { name: t('pageHeader.copyAppLink') }))
}

describe('PageHeader Copy app link', () => {
  it('copies the open page’s agaric:// link and confirms with a toast', async () => {
    const user = userEvent.setup()
    renderHeader()

    await copyAppLink(user)

    expect(mockedWriteText).toHaveBeenCalledTimes(1)
    expect(mockedWriteText).toHaveBeenCalledWith(`agaric://page/${PAGE_ID}`)
    await waitFor(() => {
      expect(vi.mocked(toast.success)).toHaveBeenCalledWith(t('pageHeader.appLinkCopied'))
    })
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: t('pageHeader.pageActions') })).toBeNull()
    })
  })

  it('the copied link, given to the deep-link router, opens the page', async () => {
    const user = userEvent.setup()
    renderHeader()
    await copyAppLink(user)
    const copied = mockedWriteText.mock.calls[0]?.[0] ?? ''
    useTabsStore.setState({
      tabs: [{ id: '0', pageStack: [{ pageId: OTHER_PAGE_ID, title: 'Elsewhere' }], label: '' }],
      activeTabIndex: 0,
    })

    dispatchLaunchUrl(copied)

    await waitFor(() => {
      const { tabs, activeTabIndex } = useTabsStore.getState()
      expect(tabs[activeTabIndex]?.pageStack.at(-1)).toEqual({ pageId: PAGE_ID, title: TITLE })
    })
  })

  it('shows an error toast when the clipboard rejects the write', async () => {
    const user = userEvent.setup()
    mockedWriteText.mockRejectedValueOnce(new Error('clipboard denied'))
    renderHeader()

    await copyAppLink(user)

    await waitFor(() => {
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageHeader.appLinkCopyFailed'))
    })
    expect(vi.mocked(toast.success)).not.toHaveBeenCalled()
  })

  it('has no a11y violations with the menu open', async () => {
    const user = userEvent.setup()
    renderHeader()
    await user.click(screen.getByRole('button', { name: t('pageHeader.pageActions') }))
    await screen.findByRole('menuitem', { name: t('pageHeader.copyAppLink') })

    // The menu is portalled out of the render container, so audit it directly.
    const menu = screen.getByRole('menu', { name: t('pageHeader.pageActions') })
    await waitFor(async () => {
      expect(await axe(menu)).toHaveNoViolations()
    })
  })
})
