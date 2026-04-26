/**
 * Tests for PageHeader component.
 *
 * Validates:
 *  - Renders page title
 *  - Renders back button when onBack provided
 *  - Does not render back button when onBack omitted
 *  - Renders tag badges for applied tags
 *  - Title editing: blur, empty revert, Enter key
 *  - Tag management: add, remove, create, search, create option
 *  - Integration: badges update after add/remove
 *  - Edge cases: no tags, title edit error
 *  - Accessibility compliance
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { StoreApi } from 'zustand'
import { useNavigationStore } from '../../stores/navigation'
import {
  createPageBlockStore,
  PageBlockContext,
  type PageBlockState,
} from '../../stores/page-blocks'
import { useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { useUndoStore } from '../../stores/undo'
import { PageHeader } from '../PageHeader'
import { TooltipProvider } from '../ui/tooltip'

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false }
let pageStore: StoreApi<PageBlockState>

// Mock lucide-react
vi.mock('lucide-react', () => ({
  AlertTriangle: () => <svg data-testid="alert-triangle-icon" />,
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  BookTemplate: () => <svg data-testid="book-template-icon" />,
  CalendarCheck2: () => <svg data-testid="calendar-check2-icon" />,
  CalendarClock: () => <svg data-testid="calendar-clock-icon" />,
  CalendarPlus: () => <svg data-testid="calendar-plus-icon" />,
  CheckCircle2: () => <svg data-testid="check-circle2-icon" />,
  ChevronDown: () => <svg data-testid="chevron-down" />,
  ChevronRight: (props: Record<string, unknown>) => <svg data-testid="chevron-right" {...props} />,
  Clock: () => <svg data-testid="clock-icon" />,
  Download: () => <svg data-testid="download-icon" />,
  ExternalLink: () => <svg data-testid="external-link-icon" />,
  FolderOutput: () => <svg data-testid="folder-output-icon" />,
  Info: () => <svg data-testid="info-icon" />,
  LayoutTemplate: (props: Record<string, unknown>) => (
    <svg data-testid="layout-template-icon" {...props} />
  ),
  Lightbulb: () => <svg data-testid="lightbulb-icon" />,
  Link: () => <svg data-testid="link-icon" />,
  List: (props: Record<string, unknown>) => <svg data-testid="list-icon" {...props} />,
  MapPin: () => <svg data-testid="map-pin-icon" />,
  MoreVertical: () => <svg data-testid="more-vertical-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
  Redo2: () => <svg data-testid="redo2-icon" />,
  Repeat: () => <svg data-testid="repeat-icon" />,
  Settings2: () => <svg data-testid="settings2-icon" />,
  Star: (props: Record<string, unknown>) => <svg data-testid="star-icon" {...props} />,
  StickyNote: () => <svg data-testid="sticky-note-icon" />,
  Tag: () => <svg data-testid="tag-icon" />,
  Trash2: () => <svg data-testid="trash2-icon" />,
  Undo2: () => <svg data-testid="undo2-icon" />,
  User: () => <svg data-testid="user-icon" />,
  X: () => <svg data-testid="x-icon" />,
  XCircle: () => <svg data-testid="x-circle-icon" />,
  XIcon: (props: Record<string, unknown>) => <svg data-testid="x-icon" {...props} />,
}))

// Mock starred-pages
vi.mock('../../lib/starred-pages', () => ({
  isStarred: vi.fn(() => false),
  toggleStarred: vi.fn(),
  getStarredPages: vi.fn(() => []),
}))

// Mock announcer (UX-282) — track screen-reader announcements per outcome
vi.mock('../../lib/announcer', () => ({
  announce: vi.fn(),
}))

import { toast } from 'sonner'
import { announce } from '../../lib/announcer'
import { isStarred, toggleStarred } from '../../lib/starred-pages'

const mockedToastError = vi.mocked(toast.error)
const mockedIsStarred = vi.mocked(isStarred)
const mockedToggleStarred = vi.mocked(toggleStarred)
const mockedAnnounce = vi.mocked(announce)

beforeEach(() => {
  vi.clearAllMocks()
  pageStore = createPageBlockStore('PAGE_1')
  useNavigationStore.setState({
    currentView: 'page-editor',
    tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_1', title: 'My Page' }], label: 'My Page' }],
    activeTabIndex: 0,
    selectedBlockId: null,
  })
  useResolveStore.setState({ cache: new Map(), pagesList: [], version: 0, _preloaded: false })
  useUndoStore.setState({ pages: new Map() })
  // FEAT-3 Phase 2 — seed two spaces so the "Move to space" sub-menu
  // (which filters out the current owner) has a non-empty target list
  // once a page's `space` property is populated.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_PERSONAL',
    availableSpaces: [
      { id: 'SPACE_PERSONAL', name: 'Personal' },
      { id: 'SPACE_WORK', name: 'Work' },
    ],
    isReady: true,
  })
  // Default: no tags exist, no tags applied
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'list_blocks') return emptyPage
    if (cmd === 'list_tags_for_block') return []
    if (cmd === 'get_properties') return []
    if (cmd === 'list_property_defs') return []
    if (cmd === 'get_page_aliases') return []
    return null
  })
})

/** Helper to set up invoke mock with tags */
function setupTagMock(appliedIds: string[] = ['TAG_1'], aliases: string[] = []) {
  // biome-ignore lint/suspicious/noExplicitAny: test mock needs flexible arg access
  mockedInvoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === 'list_blocks') {
      return {
        items: [
          {
            id: 'TAG_1',
            block_type: 'tag',
            content: 'urgent',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
            conflict_type: null,
          },
          {
            id: 'TAG_2',
            block_type: 'tag',
            content: 'review',
            parent_id: null,
            position: null,
            deleted_at: null,
            is_conflict: false,
            conflict_type: null,
          },
        ],
        next_cursor: null,
        has_more: false,
      }
    }
    if (cmd === 'list_tags_for_block') return appliedIds
    if (cmd === 'add_tag') return { block_id: args?.block_id, tag_id: args?.tag_id }
    if (cmd === 'remove_tag') return { block_id: args?.block_id, tag_id: args?.tag_id }
    if (cmd === 'create_block')
      return {
        id: 'TAG_NEW',
        block_type: 'tag',
        content: args?.content,
        parent_id: null,
        position: null,
        deleted_at: null,
        is_conflict: false,
        conflict_type: null,
      }
    if (cmd === 'edit_block')
      return {
        id: args?.blockId,
        block_type: 'page',
        content: args?.toText,
        parent_id: null,
        position: null,
      }
    if (cmd === 'get_properties') return []
    if (cmd === 'list_property_defs') return []
    if (cmd === 'get_page_aliases') return aliases
    if (cmd === 'set_page_aliases') return args?.aliases ?? []
    return null
  })
}

/** Wrap PageHeader with PageBlockStoreProvider so usePageBlockStoreApi() resolves */
function renderPageHeader(el: React.ReactElement) {
  return render(
    <TooltipProvider>
      <PageBlockContext.Provider value={pageStore}>{el}</PageBlockContext.Provider>
    </TooltipProvider>,
  )
}

describe('PageHeader rendering', () => {
  it('renders title', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Test Page" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    expect(titleEl).toBeInTheDocument()
    expect(titleEl).toHaveTextContent('My Test Page')
  })

  it('renders back button when onBack provided', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" onBack={() => {}} />)

    const backBtn = screen.getByRole('button', { name: /go back/i })
    expect(backBtn).toBeInTheDocument()
  })

  it('does not render back button when onBack omitted', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    expect(screen.queryByRole('button', { name: /go back/i })).not.toBeInTheDocument()
  })

  it('renders tag badges for applied tags', async () => {
    setupTagMock(['TAG_1'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for tags to load
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // TAG_2 (review) should not be in badges since it's not applied
    expect(screen.queryByText('review')).not.toBeInTheDocument()
  })
})

describe('PageHeader title editing', () => {
  it('updates title on blur after editing', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Old Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.type(titleEl, 'New Title')
    await user.tab()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'PAGE_1',
        toText: 'New Title',
      })
    })
  })

  it('reverts empty title on blur', async () => {
    const user = userEvent.setup()

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Original Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.tab()

    // Should revert to original title
    expect(titleEl).toHaveTextContent('Original Title')
    // Should NOT have called editBlock
    expect(mockedInvoke).not.toHaveBeenCalledWith('edit_block', expect.anything())
  })

  it('blur on Enter key', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Old Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.type(titleEl, 'Entered Title')
    await user.keyboard('{Enter}')

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('edit_block', {
        blockId: 'PAGE_1',
        toText: 'Entered Title',
      })
    })
  })
})

describe('PageHeader tag management', () => {
  it('add tag via picker', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for tags to load
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // Open tag picker
    const addBtn = screen.getByRole('button', { name: /add tag/i })
    await user.click(addBtn)

    // Wait for picker to open and click "review" tag
    await waitFor(() => {
      expect(screen.getByText('review')).toBeInTheDocument()
    })
    await user.click(screen.getByText('review'))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('add_tag', {
        blockId: 'PAGE_1',
        tagId: 'TAG_2',
      })
    })
  })

  // UX-248 — Unicode-aware fold: tag picker filter matches Turkish /
  // German / accented tag names via `matchesSearchFolded`.
  it('tag picker search matches accented tag when query is ASCII', async () => {
    const user = userEvent.setup()
    // biome-ignore lint/suspicious/noExplicitAny: test mock needs flexible arg access
    mockedInvoke.mockImplementation(async (cmd: string, _args?: any) => {
      if (cmd === 'list_blocks') {
        return {
          items: [
            {
              id: 'TAG_CAFE',
              block_type: 'tag',
              content: 'café',
              parent_id: null,
              position: null,
              deleted_at: null,
              is_conflict: false,
              conflict_type: null,
            },
            {
              id: 'TAG_PRIO',
              block_type: 'tag',
              content: 'priority',
              parent_id: null,
              position: null,
              deleted_at: null,
              is_conflict: false,
              conflict_type: null,
            },
          ],
          next_cursor: null,
          has_more: false,
        }
      }
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // No tags applied → inline "add tag" button is hidden (per UX-H10),
    // so open the picker via the kebab menu instead.
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add tag'))

    await waitFor(() => {
      expect(screen.getByText('café')).toBeInTheDocument()
      expect(screen.getByText('priority')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('Search or create tag...')
    await user.type(searchInput, 'cafe')

    await waitFor(() => {
      expect(screen.getByText('café')).toBeInTheDocument()
      expect(screen.queryByText('priority')).not.toBeInTheDocument()
    })
  })

  it('remove tag via badge X button', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for the tag badge to appear
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // Click remove button
    const removeBtn = screen.getByRole('button', { name: /remove tag urgent/i })
    await user.click(removeBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('remove_tag', {
        blockId: 'PAGE_1',
        tagId: 'TAG_1',
      })
    })
  })

  it('create new tag', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open kebab menu and click "Add tag"
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add tag'))

    // Wait for picker to open
    await waitFor(() => {
      expect(screen.getByLabelText('Search tags')).toBeInTheDocument()
    })

    // Type a new tag name
    const searchInput = screen.getByLabelText('Search tags')
    await user.type(searchInput, 'newtag')

    // Click Create button
    await waitFor(() => {
      expect(screen.getByText(/Create "newtag"/)).toBeInTheDocument()
    })
    await user.click(screen.getByText(/Create "newtag"/))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'tag',
        content: 'newtag',
        parentId: null,
        position: null,
      })
    })
  })

  it('search filters available tags', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open kebab menu and click "Add tag"
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add tag'))

    // Wait for tags to show
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
      expect(screen.getByText('review')).toBeInTheDocument()
    })

    // Type search filter
    const searchInput = screen.getByLabelText('Search tags')
    await user.type(searchInput, 'urg')

    // "urgent" should still be visible, "review" should not
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
      expect(screen.queryByText('review')).not.toBeInTheDocument()
    })
  })

  it('picker shows "Create" option for new tag name', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open kebab menu and click "Add tag"
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add tag'))

    await waitFor(() => {
      expect(screen.getByLabelText('Search tags')).toBeInTheDocument()
    })

    // Type a name that doesn't match any tag
    const searchInput = screen.getByLabelText('Search tags')
    await user.type(searchInput, 'brandnew')

    await waitFor(() => {
      expect(screen.getByText(/Create "brandnew"/)).toBeInTheDocument()
    })
  })
})

describe('PageHeader integration', () => {
  it('tag badges update after adding a tag', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for initial badge
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // "review" should not be a badge yet
    expect(screen.queryByRole('button', { name: /remove tag review/i })).not.toBeInTheDocument()

    // Open picker and add "review"
    const addBtn = screen.getByRole('button', { name: /add tag/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(screen.getByText('review')).toBeInTheDocument()
    })
    await user.click(screen.getByText('review'))

    // After adding, "review" should appear as a badge
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /remove tag review/i })).toBeInTheDocument()
    })
  })

  it('tag badges update after removing a tag', async () => {
    const user = userEvent.setup()
    setupTagMock(['TAG_1', 'TAG_2'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for both badges
    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
      expect(screen.getByText('review')).toBeInTheDocument()
    })

    // Remove "urgent"
    const removeBtn = screen.getByRole('button', { name: /remove tag urgent/i })
    await user.click(removeBtn)

    // "urgent" badge should disappear
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /remove tag urgent/i })).not.toBeInTheDocument()
    })

    // "review" should still be there
    expect(screen.getByText('review')).toBeInTheDocument()
  })
})

describe('PageHeader edge cases', () => {
  it('no tags hides tag section in header', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Tag section should not be visible when no tags applied
    expect(screen.queryByRole('button', { name: /add tag/i })).not.toBeInTheDocument()
  })

  it('handles title edit error gracefully', async () => {
    const user = userEvent.setup()

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'edit_block') throw new Error('backend error')
      if (cmd === 'get_page_aliases') return []
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Original Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })

    await user.clear(titleEl)
    await user.type(titleEl, 'Bad Title')
    await user.tab()

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to rename page')
    })

    // Title should revert
    expect(titleEl).toHaveTextContent('Original Title')
  })
})

describe('PageHeader accessibility', () => {
  it('has no a11y violations', async () => {
    const { container } = renderPageHeader(
      <PageHeader pageId="PAGE_1" title="Accessible Page" onBack={() => {}} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations with tag picker open', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    const { container } = renderPageHeader(<PageHeader pageId="PAGE_1" title="A11y Page" />)

    // Open kebab menu and click "Add tag" to show tag picker
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add tag'))

    await waitFor(() => {
      expect(screen.getByLabelText('Tag picker')).toBeInTheDocument()
    })

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// ── Alias display & editing ───────────────────────────────────────────────

describe('PageHeader alias display', () => {
  it('fetches and displays aliases on mount', async () => {
    setupTagMock([], ['daily-note', 'DN'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(screen.getByText('Also known as:')).toBeInTheDocument()
      expect(screen.getByText('daily-note')).toBeInTheDocument()
      expect(screen.getByText('DN')).toBeInTheDocument()
    })

    // Verify get_page_aliases was called
    expect(mockedInvoke).toHaveBeenCalledWith('get_page_aliases', { pageId: 'PAGE_1' })
  })

  it('hides alias section when no aliases', async () => {
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Alias section should not be visible when no aliases exist
    await waitFor(() => {
      expect(screen.queryByText('Also known as:')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /\+ add alias/i })).not.toBeInTheDocument()
    })
  })

  it('clicking Edit enables alias editing mode', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['my-alias'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render
    await waitFor(() => {
      expect(screen.getByText('my-alias')).toBeInTheDocument()
    })

    // Click the Edit button
    const editBtn = screen.getByRole('button', { name: /edit/i })
    await user.click(editBtn)

    // Should now show the alias input form
    await waitFor(() => {
      expect(screen.getByLabelText('New alias input')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
    })

    // Should show remove button on existing alias
    expect(screen.getByRole('button', { name: /remove alias my-alias/i })).toBeInTheDocument()
  })

  it('adding an alias calls setPageAliases', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['existing-alias'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render, then enter edit mode
    await waitFor(() => {
      expect(screen.getByText('existing-alias')).toBeInTheDocument()
    })

    const editBtn = screen.getByRole('button', { name: /edit/i })
    await user.click(editBtn)

    // Type a new alias and submit
    const aliasInput = screen.getByLabelText('New alias input')
    await user.type(aliasInput, 'new-alias')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_page_aliases', {
        pageId: 'PAGE_1',
        aliases: ['existing-alias', 'new-alias'],
      })
    })

    // The new alias should appear in the UI
    expect(screen.getByText('new-alias')).toBeInTheDocument()
  })

  it('removing an alias calls setPageAliases', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['alias-a', 'alias-b'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render
    await waitFor(() => {
      expect(screen.getByText('alias-a')).toBeInTheDocument()
      expect(screen.getByText('alias-b')).toBeInTheDocument()
    })

    // Enter edit mode
    const editBtn = screen.getByRole('button', { name: /edit/i })
    await user.click(editBtn)

    // Remove alias-a
    const removeBtn = screen.getByRole('button', { name: /remove alias alias-a/i })
    await user.click(removeBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_page_aliases', {
        pageId: 'PAGE_1',
        aliases: ['alias-b'],
      })
    })
  })

  it('"Add alias" available in kebab menu when no aliases exist', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open kebab menu
    await user.click(screen.getByRole('button', { name: /page actions/i }))

    // "Add alias" should be in the kebab menu
    expect(await screen.findByText('Add alias')).toBeInTheDocument()
  })

  it('shows "Edit" button (not "Add Alias") when aliases exist', async () => {
    setupTagMock([], ['my-alias'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(screen.getByText('my-alias')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add alias/i })).not.toBeInTheDocument()
  })

  it('alias section not rendered when no aliases and not editing', async () => {
    setupTagMock([], [])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // No alias editing UI should be visible
    await waitFor(() => {
      expect(screen.queryByLabelText('New alias input')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /\+ add alias/i })).not.toBeInTheDocument()
    })
  })

  it('does not show Plus icon when aliases exist', async () => {
    setupTagMock([], ['some-alias'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(screen.getByText('some-alias')).toBeInTheDocument()
    })

    // The Edit button should NOT contain a Plus icon
    const editButton = screen.getByRole('button', { name: /edit/i })
    expect(editButton.querySelector('[data-testid="plus-icon"]')).toBeNull()
  })

  it('alias badges use the same styling pattern as tag badges', async () => {
    setupTagMock(['TAG_1'], ['alias-1'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test" />)

    // Wait for both alias and tag badges to render
    await waitFor(() => {
      expect(screen.getByText('alias-1')).toBeInTheDocument()
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })

    // Alias badges should use Badge component (has data-slot="badge")
    const aliasBadge = screen.getByText('alias-1').closest('[data-slot="badge"]')
    expect(aliasBadge).toBeInTheDocument()

    // Tag badges should also use Badge component
    const tagBadge = screen.getByText('urgent').closest('[data-slot="badge"]')
    expect(tagBadge).toBeInTheDocument()

    // Both should have the same variant
    expect(aliasBadge).toHaveAttribute('data-variant', 'secondary')
    expect(tagBadge).toHaveAttribute('data-variant', 'secondary')
  })
})

// ── Page-level undo / redo buttons ────────────────────────────────────────

describe('PageHeader page-level undo/redo buttons', () => {
  it('renders page undo button', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    const undoBtn = screen.getByRole('button', { name: /undo last page action/i })
    expect(undoBtn).toBeInTheDocument()
  })

  it('renders page redo button', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    const redoBtn = screen.getByRole('button', { name: /redo last page action/i })
    expect(redoBtn).toBeInTheDocument()
  })

  it('undo button calls undoPageOp', async () => {
    const user = userEvent.setup()

    // Set up invoke mock so undo_page_op returns a valid UndoResult
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'undo_page_op')
        return {
          reversed_op: { device_id: 'dev1', seq: 1 },
          new_op_ref: { device_id: 'dev1', seq: 2 },
          new_op_type: 'reverse',
          is_redo: false,
        }
      if (cmd === 'get_block')
        return {
          id: 'PAGE_1',
          block_type: 'page',
          content: 'My Page',
          parent_id: null,
          position: null,
          deleted_at: null,
          is_conflict: false,
          conflict_type: null,
        }
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    const undoBtn = screen.getByRole('button', { name: /undo last page action/i })
    await user.click(undoBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('undo_page_op', {
        pageId: 'PAGE_1',
        undoDepth: 0,
      })
    })
  })
})

// ── Breadcrumb navigation for namespaced pages (UX-257) ──────────────────

describe('PageHeader breadcrumb', () => {
  it('shows breadcrumb for namespaced page title', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="work/project-alpha/tasks" />)

    const nav = screen.getByRole('navigation', { name: /page breadcrumb/i })
    expect(nav).toBeInTheDocument()

    // Ancestor segments should appear as buttons
    expect(screen.getByRole('button', { name: 'work' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'project-alpha' })).toBeInTheDocument()

    // Final segment should appear as plain text (not a button)
    expect(nav).toHaveTextContent('tasks')
    const buttons = nav.querySelectorAll('button')
    const buttonTexts = Array.from(buttons).map((b) => b.textContent)
    expect(buttonTexts).not.toContain('tasks')

    // FEAT-13: final crumb is the active step and carries aria-current="page".
    const finalCrumb = nav.querySelector('[aria-current="page"]')
    expect(finalCrumb).not.toBeNull()
    expect(finalCrumb?.textContent).toBe('tasks')
  })

  // UX-257 — slashes are replaced with the canonical chevron separator from
  // the shared Breadcrumb primitive. Verify the chevron is present and no
  // visible `/` glyph remains in the bar.
  it('uses chevron separators between segments (not slashes)', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="work/project-alpha/tasks" />)
    const nav = screen.getByRole('navigation', { name: /page breadcrumb/i })

    const seps = nav.querySelectorAll('[data-slot="breadcrumb-separator"]')
    // 3 segments → 2 separators (no home in PageHeader)
    expect(seps.length).toBe(2)

    // Each separator is the mocked ChevronRight stub (svg with the testid).
    for (const sep of seps) {
      expect(sep.getAttribute('data-testid')).toBe('chevron-right')
    }

    // The bar must not render `/` as a visible separator.
    expect(nav.textContent ?? '').not.toContain('/')
  })

  it('does not show breadcrumb for flat page title', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Simple Page" />)

    expect(screen.queryByRole('navigation', { name: /page breadcrumb/i })).not.toBeInTheDocument()
  })

  it('breadcrumb ancestor navigates to pages view', async () => {
    const user = userEvent.setup()
    renderPageHeader(<PageHeader pageId="PAGE_1" title="work/project-alpha" />)

    const workBtn = screen.getByRole('button', { name: 'work' })
    await user.click(workBtn)

    expect(useNavigationStore.getState().currentView).toBe('pages')
  })

  it('a11y: no violations with breadcrumb', async () => {
    const { container } = renderPageHeader(
      <PageHeader pageId="PAGE_1" title="work/project-alpha/tasks" onBack={() => {}} />,
    )

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

// ── Kebab menu (#639) ─────────────────────────────────────────────────────

describe('PageHeader kebab menu (#639)', () => {
  it('renders page actions menu button', async () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /page actions/i })).toBeInTheDocument()
    })
  })

  it('shows "Save as template" when page is not a template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Save as template/i)).toBeInTheDocument()
  })

  it('shows "Remove template status" when page is a template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties')
        return [
          {
            key: 'template',
            value_text: 'true',
            value_num: null,
            value_date: null,
            value_ref: null,
          },
        ]
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Remove template status/i)).toBeInTheDocument()
  })

  it('shows "Set as journal template" when page is not a journal template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Set as journal template/i)).toBeInTheDocument()
  })

  it('shows "Remove journal template" when page is a journal template', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties')
        return [
          {
            key: 'journal-template',
            value_text: 'true',
            value_num: null,
            value_date: null,
            value_ref: null,
          },
        ]
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      return null
    })
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Remove journal template/i)).toBeInTheDocument()
  })

  it('toggles template property on click', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'set_property') return null
      return null
    })
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Save as template/i))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'template',
        valueText: 'true',
        valueNum: null,
        valueDate: null,
        valueRef: null,
      })
    })
  })

  it('shows Export as Markdown option', async () => {
    const user = userEvent.setup()
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Export as Markdown/i)).toBeInTheDocument()
  })

  it('shows Delete page option', async () => {
    const user = userEvent.setup()
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Delete page/i)).toBeInTheDocument()
  })
})

// ── Kebab menu reorganization (UX-H10 / UX-H12) ─────────────────────────

describe('PageHeader kebab menu reorganization (UX-H10/H12)', () => {
  it('alias section hidden when no aliases exist', async () => {
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(screen.queryByText('Also known as:')).not.toBeInTheDocument()
    })
  })

  it('tag section hidden when no tags exist', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    expect(screen.queryByRole('button', { name: /add tag/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /remove tag/i })).not.toBeInTheDocument()
  })

  it('kebab menu shows "Add alias", "Add tag", "Add property" items', async () => {
    const user = userEvent.setup()
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText('Add alias')).toBeInTheDocument()
    expect(screen.getByText('Add tag')).toBeInTheDocument()
    expect(screen.getByText('Add property')).toBeInTheDocument()
  })

  it('clicking kebab "Add alias" shows alias editor', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open kebab and click "Add alias"
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add alias'))

    // Alias editing form should appear
    await waitFor(() => {
      expect(screen.getByLabelText('New alias input')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /done/i })).toBeInTheDocument()
    })
  })

  it('clicking kebab "Add tag" shows tag picker', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open kebab and click "Add tag"
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add tag'))

    // Tag picker should appear
    await waitFor(() => {
      expect(screen.getByLabelText('Tag picker')).toBeInTheDocument()
    })
  })

  it('clicking kebab "Add property" shows property table', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Open kebab and click "Add property"
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText('Add property'))

    // Property table should appear
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Properties/ })).toBeInTheDocument()
    })
  })

  it('aliases shown when aliases exist', async () => {
    setupTagMock([], ['my-alias'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(screen.getByText('Also known as:')).toBeInTheDocument()
      expect(screen.getByText('my-alias')).toBeInTheDocument()
    })
  })

  it('tags shown when tags exist', async () => {
    setupTagMock(['TAG_1'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(screen.getByText('urgent')).toBeInTheDocument()
    })
  })
})

// ── Error path tests ──────────────────────────────────────────────────────

describe('PageHeader error paths', () => {
  it('undo_page_op rejection is handled gracefully (no crash, depth rolled back)', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'undo_page_op') throw new Error('backend undo failed')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)
    const undoBtn = screen.getByRole('button', { name: /undo last page action/i })
    await user.click(undoBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('undo_page_op', {
        pageId: 'PAGE_1',
        undoDepth: 0,
      })
    })

    // Store catches the error and rolls back — undo depth should be 0
    expect(useUndoStore.getState().pages.get('PAGE_1')?.undoDepth ?? 0).toBe(0)
  })

  it('redo_page_op rejection is handled gracefully (redo stack restored)', async () => {
    const user = userEvent.setup()

    // Set up redo stack so redo is available
    useUndoStore.setState({
      pages: new Map([
        [
          'PAGE_1',
          {
            redoStack: [{ device_id: 'dev1', seq: 1 }],
            undoDepth: 1,
            redoGroupSizes: [1],
          },
        ],
      ]),
    })

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'redo_page_op') throw new Error('backend redo failed')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)
    const redoBtn = screen.getByRole('button', { name: /redo last page action/i })
    await user.click(redoBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('redo_page_op', {
        undoDeviceId: 'dev1',
        undoSeq: 1,
      })
    })

    // Store catches error and rolls back — redo stack should be restored
    const pageState = useUndoStore.getState().pages.get('PAGE_1')
    expect(pageState?.redoStack).toHaveLength(1)
    expect(pageState?.undoDepth).toBe(1)
  })

  it('toggle template on rejection shows error toast', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'set_property') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Save as template/i))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to update template status')
    })
  })

  it('toggle template off rejection shows error toast', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties')
        return [
          {
            key: 'template',
            value_text: 'true',
            value_num: null,
            value_date: null,
            value_ref: null,
          },
        ]
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'delete_property') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Remove template status/i))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to update template status')
    })
  })

  it('toggle journal template rejection shows error toast', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'set_property') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Set as journal template/i))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to update journal template')
    })
  })

  it('export_page_markdown rejection shows error toast', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'export_page_markdown') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Export as Markdown/i))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Export failed')
    })
  })

  it('delete_block rejection shows error toast and does not navigate back', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()

    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'delete_block') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" onBack={onBack} />)

    // Open kebab, click "Delete page" to open confirmation dialog
    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Delete page/i))

    // Confirm in the alert dialog
    const confirmBtn = await screen.findByRole('button', { name: /^Delete page$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to delete page')
    })
    expect(onBack).not.toHaveBeenCalled()
  })

  it('get_page_aliases rejection on mount shows error toast', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('pageHeader.loadAliasesFailed')
    })
  })

  it('set_page_aliases rejection when adding alias shows error toast', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['existing-alias'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render, then enter edit mode
    await waitFor(() => {
      expect(screen.getByText('existing-alias')).toBeInTheDocument()
    })
    await user.click(screen.getByRole('button', { name: /edit/i }))

    // Override mock to reject set_page_aliases while keeping others working
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_page_aliases') throw new Error('backend error')
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return ['existing-alias']
      return null
    })

    // Type a new alias and submit
    const aliasInput = screen.getByLabelText('New alias input')
    await user.type(aliasInput, 'new-alias')
    await user.click(screen.getByRole('button', { name: /^add$/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to update aliases')
    })
  })

  it('set_page_aliases rejection when removing alias shows error toast', async () => {
    const user = userEvent.setup()
    setupTagMock([], ['alias-a', 'alias-b'])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Wait for aliases to render
    await waitFor(() => {
      expect(screen.getByText('alias-a')).toBeInTheDocument()
    })

    // Enter edit mode
    await user.click(screen.getByRole('button', { name: /edit/i }))

    // Override mock to reject set_page_aliases
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'set_page_aliases') throw new Error('backend error')
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return ['alias-a', 'alias-b']
      return null
    })

    // Remove alias-a
    await user.click(screen.getByRole('button', { name: /remove alias alias-a/i }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to update aliases')
    })
  })
})

// ── Keyboard shortcut for export (UX-158) ────────────────────────────────

describe('PageHeader export keyboard shortcut (UX-158)', () => {
  it('Ctrl+Shift+E triggers export', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'export_page_markdown') return '# My Page\n\nSome content'
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    // Simulate Ctrl+Shift+E
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'E',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    )

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('export_page_markdown', {
        pageId: 'PAGE_1',
      })
    })
  })
})

// ── Star / favourite button (UX-156) ──────────────────────────────────────

describe('PageHeader star button (UX-156)', () => {
  it('renders star button', () => {
    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    const starBtn = screen.getByRole('button', { name: /star this page/i })
    expect(starBtn).toBeInTheDocument()
  })

  it('toggles star on click', async () => {
    const user = userEvent.setup()

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    const starBtn = screen.getByRole('button', { name: /star this page/i })
    await user.click(starBtn)

    expect(mockedToggleStarred).toHaveBeenCalledWith('PAGE_1')
  })

  it('shows filled star when page is starred', () => {
    mockedIsStarred.mockReturnValue(true)

    renderPageHeader(<PageHeader pageId="PAGE_1" title="My Page" />)

    const starBtn = screen.getByRole('button', { name: /unstar this page/i })
    expect(starBtn).toBeInTheDocument()

    const starIcon = screen.getByTestId('star-icon')
    expect(starIcon).toHaveAttribute('fill', 'currentColor')
  })
})

// ── Rich title rendering (BUG-1) ──────────────────────────────────────────

describe('PageHeader rich title rendering (BUG-1)', () => {
  const BLOCK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

  it('plain text title renders as contentEditable', () => {
    setupTagMock([])
    renderPageHeader(<PageHeader pageId="PAGE_1" title="Plain Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    expect(titleEl).toHaveAttribute('contenteditable')
    expect(titleEl).toHaveTextContent('Plain Title')
  })

  it('title with [[ULID]] renders without contentEditable in display mode', () => {
    setupTagMock([])
    useResolveStore.setState({
      cache: new Map([[BLOCK_ID, { title: 'Linked Page', deleted: false }]]),
      pagesList: [],
      version: 1,
      _preloaded: false,
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title={`See [[${BLOCK_ID}]]`} />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    expect(titleEl).not.toHaveAttribute('contenteditable')
  })

  it('clicking rich display transitions to edit mode', async () => {
    const user = userEvent.setup()
    setupTagMock([])
    useResolveStore.setState({
      cache: new Map([[BLOCK_ID, { title: 'Linked Page', deleted: false }]]),
      pagesList: [],
      version: 1,
      _preloaded: false,
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title={`See [[${BLOCK_ID}]]`} />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    expect(titleEl).not.toHaveAttribute('contenteditable')

    await user.click(titleEl)

    await waitFor(() => {
      const editEl = screen.getByRole('textbox', { name: /page title/i })
      expect(editEl).toHaveAttribute('contenteditable')
    })
  })

  it('a11y: no violations with rich title display', async () => {
    setupTagMock([])
    useResolveStore.setState({
      cache: new Map([[BLOCK_ID, { title: 'Linked Page', deleted: false }]]),
      pagesList: [],
      version: 1,
      _preloaded: false,
    })

    const { container } = renderPageHeader(
      <PageHeader pageId="PAGE_1" title={`See [[${BLOCK_ID}]]`} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// UX-198: PageHeader used to render its content inside a `sticky top-0`
// wrapper div. It's now hoisted to the App-level outlet via <ViewHeader>.
// The header's children (title editor, star button, etc.) must still render
// (via ViewHeader's inline fallback) but the stale sticky classes must be
// gone from the component's subtree.
describe('PageHeader UX-198 header outlet migration', () => {
  it('no sticky top-0 wrapper but header content still renders', () => {
    const { container } = renderPageHeader(<PageHeader pageId="PAGE_1" title="Hoist test" />)
    // The title editor (inside the old header wrapper) still renders.
    expect(screen.getByRole('textbox', { name: /page title/i })).toBeInTheDocument()
    // The old sticky wrapper is gone.
    const sticky = container.querySelector('.sticky.top-0')
    expect(sticky).toBeNull()
  })
})

// ── Move to space (FEAT-3 Phase 2) ──────────────────────────────────────
//
// The kebab menu learns a new entry that reveals a sub-menu of every
// space except the current owner. Selecting a target calls `setProperty`
// to rewrite `space=<targetSpaceId>` and fires a success toast. The
// entry is hidden when the page itself is a space block (spaces can't
// be nested inside other spaces).

describe('PageHeader Move to space (FEAT-3 Phase 2)', () => {
  const mockedToastSuccess = vi.mocked(toast.success)

  /** Install an invoke mock that returns a page owned by `spaceId`. */
  function setupPageWithSpace(
    spaceId: string,
    opts: { isSpace?: boolean } = {},
  ): typeof mockedInvoke {
    interface PropertyRow {
      key: string
      value_text: string | null
      value_num: number | null
      value_date: string | null
      value_ref: string | null
    }
    mockedInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') {
        const props: PropertyRow[] = [
          {
            key: 'space',
            value_text: null,
            value_num: null,
            value_date: null,
            value_ref: spaceId,
          },
        ]
        if (opts.isSpace) {
          props.push({
            key: 'is_space',
            value_text: 'true',
            value_num: null,
            value_date: null,
            value_ref: null,
          })
        }
        return props
      }
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'set_property') {
        const record = args as Record<string, unknown> | undefined
        return { block_id: record?.['blockId'] }
      }
      return null
    })
    return mockedInvoke
  }

  it('renders the "Move to space" menu item when the page is a regular page', async () => {
    const user = userEvent.setup()
    setupPageWithSpace('SPACE_PERSONAL')

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))

    expect(await screen.findByText(/Move to space/i)).toBeInTheDocument()
  })

  it('hides "Move to space" when the page is itself a space block', async () => {
    const user = userEvent.setup()
    setupPageWithSpace('SPACE_PERSONAL', { isSpace: true })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Personal" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    // The Export entry is always shown so waiting for it proves the menu
    // rendered to completion before asserting on absence.
    await screen.findByText(/Export as Markdown/i)

    expect(screen.queryByText(/Move to space/i)).not.toBeInTheDocument()
  })

  it('sub-menu lists every space except the current owner (alphabetical)', async () => {
    const user = userEvent.setup()
    setupPageWithSpace('SPACE_PERSONAL')

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Move to space/i))

    const submenu = await screen.findByRole('menu', { name: /Move to space/i })
    // "Work" appears; "Personal" (the current owner) is filtered out.
    expect(within(submenu).getByRole('menuitem', { name: 'Work' })).toBeInTheDocument()
    expect(within(submenu).queryByRole('menuitem', { name: 'Personal' })).not.toBeInTheDocument()
  })

  it('click on a target fires set_property and shows the success toast', async () => {
    const user = userEvent.setup()
    setupPageWithSpace('SPACE_PERSONAL')

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Move to space/i))
    await user.click(await screen.findByRole('menuitem', { name: 'Work' }))

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
        blockId: 'PAGE_1',
        key: 'space',
        valueText: null,
        valueNum: null,
        valueDate: null,
        valueRef: 'SPACE_WORK',
      })
    })
    await waitFor(() => {
      expect(mockedToastSuccess).toHaveBeenCalledWith(expect.stringMatching(/moved to Work/i))
    })
  })

  it('shows error toast when set_property rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties')
        return [
          {
            key: 'space',
            value_text: null,
            value_num: null,
            value_date: null,
            value_ref: 'SPACE_PERSONAL',
          },
        ]
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'set_property') throw new Error('write failed')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Move to space/i))
    await user.click(await screen.findByRole('menuitem', { name: 'Work' }))

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith(expect.stringMatching(/Failed to move page/i))
    })
  })

  it('has no a11y violations with the Move to space sub-menu expanded', async () => {
    const user = userEvent.setup()
    setupPageWithSpace('SPACE_PERSONAL')

    const { container } = renderPageHeader(<PageHeader pageId="PAGE_1" title="Test" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Move to space/i))
    await screen.findByRole('menu', { name: /Move to space/i })

    await waitFor(
      async () => {
        const results = await axe(container)
        expect(results).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

// ── Screen reader announcements (UX-282) ──────────────────────────────────

describe('PageHeader screen reader announcements (UX-282)', () => {
  it('announces page renamed after a successful title edit', async () => {
    const user = userEvent.setup()
    setupTagMock([])

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Old Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    await user.clear(titleEl)
    await user.type(titleEl, 'New Title')
    await user.tab()

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Page renamed')
    })
  })

  it('announces page rename failed when edit_block rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'edit_block') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Old Title" />)

    const titleEl = screen.getByRole('textbox', { name: /page title/i })
    await user.clear(titleEl)
    await user.type(titleEl, 'Broken Title')
    await user.tab()

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Page rename failed')
    })
  })

  it('announces page deleted on successful delete confirmation', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" onBack={onBack} />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Delete page/i))

    const confirmBtn = await screen.findByRole('button', { name: /^Delete page$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Page deleted')
    })
  })

  it('announces page delete failed when delete_block rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'delete_block') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" onBack={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Delete page/i))

    const confirmBtn = await screen.findByRole('button', { name: /^Delete page$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Page delete failed')
    })
  })

  it('announces export success after Export as Markdown', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'export_page_markdown') return '# Test\n'
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Export as Markdown/i))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Page exported to clipboard')
    })
  })

  it('announces export failed when export_page_markdown rejects', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_blocks') return emptyPage
      if (cmd === 'list_tags_for_block') return []
      if (cmd === 'get_properties') return []
      if (cmd === 'list_property_defs') return []
      if (cmd === 'get_page_aliases') return []
      if (cmd === 'export_page_markdown') throw new Error('backend error')
      return null
    })

    renderPageHeader(<PageHeader pageId="PAGE_1" title="Test Page" />)

    await user.click(screen.getByRole('button', { name: /page actions/i }))
    await user.click(await screen.findByText(/Export as Markdown/i))

    await waitFor(() => {
      expect(mockedAnnounce).toHaveBeenCalledWith('Export failed')
    })
  })
})
