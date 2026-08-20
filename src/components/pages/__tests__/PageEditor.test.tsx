/**
 * Tests for PageEditor component.
 *
 * Validates:
 *  - Renders PageHeader with correct props
 *  - Renders BlockTree with correct parentId
 *  - Add block button creates a new block
 *  - a11y compliance
 *  - Reloads blocks when pageId prop changes
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

// ── Mock BlockTree ──────────────────────────────────────────────────
// BlockTree is heavy (DnD, TipTap, viewport observer). Mock it to a
// simple div that exposes the parentId prop for verification.
//
// #4011 — also captures `onRevealSettled` so tests can call it directly to
// simulate BlockTree's real reveal effect reporting its outcome, instead of
// simulating the OLD frame-polling mechanism PageEditor no longer has.
let capturedParentId: string | undefined
let capturedAutoCreateFirstBlock: boolean | undefined
let capturedOnRevealSettled: ((blockId: string, found: boolean) => void) | undefined
vi.mock('@/components/editor/BlockTree', () => ({
  BlockTree: (props: {
    parentId?: string
    autoCreateFirstBlock?: boolean
    onRevealSettled?: (blockId: string, found: boolean) => void
  }) => {
    capturedParentId = props.parentId
    capturedAutoCreateFirstBlock = props.autoCreateFirstBlock
    capturedOnRevealSettled = props.onRevealSettled
    return (
      <div
        data-testid="block-tree"
        data-parent-id={props.parentId ?? ''}
        data-auto-create={props.autoCreateFirstBlock ?? true}
        className="block-tree"
      />
    )
  },
}))

// ── Mock PageHeader ─────────────────────────────────────────────────
let capturedPageHeaderProps: { pageId: string; title: string; onBack?: () => void } | null = null
vi.mock('@/components/pages/PageHeader', () => ({
  PageHeader: (props: { pageId: string; title: string; onBack?: () => void }) => {
    capturedPageHeaderProps = props
    return <div data-testid="page-header" data-page-id={props.pageId} data-title={props.title} />
  },
}))

// ── Mock panel components ───────────────────────────────────────────
let capturedLinkedRefsPageId: string | undefined
vi.mock('@/components/backlinks/LinkedReferences', () => ({
  LinkedReferences: (props: { pageId: string; onNavigateToPage?: unknown }) => {
    capturedLinkedRefsPageId = props.pageId
    return <div data-testid="linked-references" data-page-id={props.pageId} />
  },
}))

let capturedPagesTreeSectionProps: { pageId: string; pageTitle: string } | undefined
vi.mock('@/components/pages/PagesTreeSection', () => ({
  PagesTreeSection: (props: { pageId: string; pageTitle: string; onNavigateToPage?: unknown }) => {
    capturedPagesTreeSectionProps = { pageId: props.pageId, pageTitle: props.pageTitle }
    return (
      <div
        data-testid="pages-tree-section"
        data-page-id={props.pageId}
        data-page-title={props.pageTitle}
      />
    )
  },
}))

let capturedUnlinkedRefsProps: { pageId: string; pageTitle: string } | undefined
vi.mock('@/components/backlinks/UnlinkedReferences', () => ({
  UnlinkedReferences: (props: {
    pageId: string
    pageTitle: string
    onNavigateToPage?: unknown
  }) => {
    capturedUnlinkedRefsProps = { pageId: props.pageId, pageTitle: props.pageTitle }
    return (
      <div
        data-testid="unlinked-references"
        data-page-id={props.pageId}
        data-page-title={props.pageTitle}
      />
    )
  },
}))

let capturedDuePanelDate: string | undefined
let capturedDuePanelExcludePageId: string | undefined
vi.mock('@/components/agenda/DuePanel', () => ({
  DuePanel: (props: { date: string; onNavigateToPage?: unknown; excludePageId?: string }) => {
    capturedDuePanelDate = props.date
    capturedDuePanelExcludePageId = props.excludePageId
    return <div data-testid="due-panel" data-date={props.date} data-exclude={props.excludePageId} />
  },
}))

let capturedDonePanelDate: string | undefined
let capturedDonePanelExcludePageId: string | undefined
vi.mock('@/components/agenda/DonePanel', () => ({
  DonePanel: (props: { date: string; onNavigateToPage?: unknown; excludePageId?: string }) => {
    capturedDonePanelDate = props.date
    capturedDonePanelExcludePageId = props.excludePageId
    return (
      <div data-testid="done-panel" data-date={props.date} data-exclude={props.excludePageId} />
    )
  },
}))

// ── Mock PageMetadataBar ────────────────────────────────────────────
vi.mock('@/components/pages/PageMetadataBar', () => ({
  PageMetadataBar: (props: { blocks: unknown[]; pageId: string }) => (
    <div data-testid="page-metadata-bar" data-page-id={props.pageId} />
  ),
}))

// ── Mock lucide-react ───────────────────────────────────────────────
vi.mock('lucide-react', () => ({
  ArrowLeft: () => <svg data-testid="arrow-left-icon" />,
  Plus: () => <svg data-testid="plus-icon" />,
}))

import { toast } from 'sonner'

import { makeBlock } from '@/__tests__/fixtures'
import { PageEditor } from '@/components/pages/PageEditor'
import { t } from '@/lib/i18n'
import { useBlockStore } from '@/stores/blocks'
import { useNavigationStore } from '@/stores/navigation'
import { getPageStore } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'
import { useTabsStore } from '@/stores/tabs'
import { useUndoStore } from '@/stores/undo'

const TEST_SPACE_ID = '01TESTSPACE0000000000000XX'

const mockedInvoke = vi.mocked(invoke)
const mockedToastError = vi.mocked(toast.error)

beforeEach(() => {
  vi.clearAllMocks()
  capturedParentId = undefined
  capturedAutoCreateFirstBlock = undefined
  capturedOnRevealSettled = undefined
  capturedLinkedRefsPageId = undefined
  capturedPagesTreeSectionProps = undefined
  capturedUnlinkedRefsProps = undefined
  capturedPageHeaderProps = null
  capturedDuePanelDate = undefined
  capturedDonePanelDate = undefined
  capturedDuePanelExcludePageId = undefined
  capturedDonePanelExcludePageId = undefined
  // Reset the Zustand stores to a clean state before each test
  useBlockStore.setState({
    focusedBlockId: null,
    selectedBlockIds: [],
  })
  // #1075 — page-store slots self-clean when their provider unmounts; RTL's
  // afterEach `cleanup()` unmounts every rendered tree between tests, so no
  // explicit registry reset is needed.
  useUndoStore.setState({ pages: new Map() })
  useNavigationStore.setState({
    currentView: 'page-editor',
    selectedBlockId: null,
  })
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [{ pageId: 'PAGE_1', title: 'My Page' }], label: 'My Page' }],
    activeTabIndex: 0,
  })
  // FE-H-22: page-blocks `load()` now early-returns when `currentSpaceId`
  // is null. Seed a non-null space so existing tests keep driving the
  // IPC path.
  useSpaceStore.setState({ currentSpaceId: TEST_SPACE_ID })
})

describe('PageEditor', () => {
  it('passes correct props to PageHeader', () => {
    const onBack = vi.fn()
    render(<PageEditor pageId="PAGE_1" title="My Test Page" onBack={onBack} />)

    expect(capturedPageHeaderProps).not.toBeNull()
    expect(capturedPageHeaderProps?.pageId).toBe('PAGE_1')
    expect(capturedPageHeaderProps?.title).toBe('My Test Page')
    expect(capturedPageHeaderProps?.onBack).toBe(onBack)
  })

  it('renders PageHeader component', () => {
    render(<PageEditor pageId="PAGE_1" title="My Test Page" />)

    const header = screen.getByTestId('page-header')
    expect(header).toBeInTheDocument()
    expect(header).toHaveAttribute('data-page-id', 'PAGE_1')
    expect(header).toHaveAttribute('data-title', 'My Test Page')
  })

  it('renders BlockTree with correct parentId', () => {
    render(<PageEditor pageId="PAGE_123" title="Test" />)

    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toBeInTheDocument()
    expect(blockTree).toHaveAttribute('data-parent-id', 'PAGE_123')
    expect(capturedParentId).toBe('PAGE_123')
  })

  it('renders LinkedReferences with correct pageId', () => {
    render(<PageEditor pageId="PAGE_123" title="Test" />)

    const linkedRefs = screen.getByTestId('linked-references')
    expect(linkedRefs).toBeInTheDocument()
    expect(linkedRefs).toHaveAttribute('data-page-id', 'PAGE_123')
    expect(capturedLinkedRefsPageId).toBe('PAGE_123')
  })

  it('renders UnlinkedReferences with correct pageId and pageTitle', () => {
    render(<PageEditor pageId="PAGE_123" title="Test Title" />)

    const unlinkedRefs = screen.getByTestId('unlinked-references')
    expect(unlinkedRefs).toBeInTheDocument()
    expect(unlinkedRefs).toHaveAttribute('data-page-id', 'PAGE_123')
    expect(unlinkedRefs).toHaveAttribute('data-page-title', 'Test Title')
    expect(capturedUnlinkedRefsProps).toEqual({
      pageId: 'PAGE_123',
      pageTitle: 'Test Title',
    })
  })

  it('renders PagesTreeSection with correct pageId and pageTitle', () => {
    render(<PageEditor pageId="PAGE_123" title="Test Title" />)

    const pagesTree = screen.getByTestId('pages-tree-section')
    expect(pagesTree).toBeInTheDocument()
    expect(pagesTree).toHaveAttribute('data-page-id', 'PAGE_123')
    expect(pagesTree).toHaveAttribute('data-page-title', 'Test Title')
    expect(capturedPagesTreeSectionProps).toEqual({
      pageId: 'PAGE_123',
      pageTitle: 'Test Title',
    })
  })

  it('updates BlockTree parentId when pageId prop changes', () => {
    const { rerender } = render(<PageEditor pageId="PAGE_A" title="Page A" />)

    expect(capturedParentId).toBe('PAGE_A')

    rerender(<PageEditor pageId="PAGE_B" title="Page B" />)

    expect(capturedParentId).toBe('PAGE_B')
    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toHaveAttribute('data-parent-id', 'PAGE_B')
  })

  it('renders Add block button', () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    expect(addBtn).toBeInTheDocument()
  })

  it('Add block button creates a new block when blocks exist', async () => {
    const user = userEvent.setup()

    // Mock createBlock response for the new block
    mockedInvoke.mockResolvedValueOnce({
      id: 'B2',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 1,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Pre-populate per-page store with a block (via registry after mount)
    act(() => {
      getPageStore('PAGE_1')?.setState({
        blocks: [makeBlock({ id: 'B1', content: 'First block', parent_id: 'PAGE_1', position: 0 })],
      })
    })

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    // #2849 PR2 — "Add block" with blocks present routes through createBelow,
    // which mints the id CLIENT-side and passes it as `blockId`; the new block
    // carries that client ULID (the mock's server id is ignored). Capture it
    // from the store rather than expecting the server-minted 'B2'.
    await waitFor(() => {
      expect(getPageStore('PAGE_1')?.getState().blocks).toHaveLength(2)
    })
    const newId = getPageStore('PAGE_1')
      ?.getState()
      .blocks.find((b) => b.id !== 'B1')?.id
    expect(newId).toBeDefined()

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          blockType: 'content',
          content: '',
          parentId: 'PAGE_1',
          index: 1,
          scope: { kind: 'global' },
          blockId: newId,
        }),
      )
    })

    // Should focus the new (client-id) block
    await waitFor(() => {
      const state = useBlockStore.getState()
      expect(state.focusedBlockId).toBe(newId)
    })
  })

  it('Add block button creates first block when no blocks exist (splice, no re-list)', async () => {
    const user = userEvent.setup()

    // Store starts empty (per-page store is fresh)

    // Mock createBlock response for the new block. —
    // there is no longer a follow-up list_blocks IPC; the row is spliced
    // into the local store via pageStore.appendBlock(row).
    mockedInvoke.mockResolvedValueOnce({
      id: 'B1',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 0,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'PAGE_1',
        index: null,
        scope: { kind: 'global' },
        // #2849 PR2 — the empty-page path calls createBlock directly with no
        // client id (createBelow needs an anchor), so the binding sends null.
        blockId: null,
      })
    })

    // Tier 4.2 — empty-page first-block-create must NOT re-fetch the page.
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_blocks', expect.anything())

    // The new block is spliced into the local store and surfaces via the
    // registered store. focused id is set to the new block.
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('B1')
    })
    const stored = getPageStore('PAGE_1')?.getState().blocks ?? []
    expect(stored.map((b) => b.id)).toEqual(['B1'])
  })

  it('Add block button creates top-level block when page has nested blocks', async () => {
    const user = userEvent.setup()

    // Mock createBlock response — the new block should be under PAGE_1
    mockedInvoke.mockResolvedValueOnce({
      id: 'B4',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 1,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Pre-populate per-page store with a nested block tree:
    //   B1 (depth 0, parent PAGE_1)
    //     B2 (depth 1, parent B1)
    //       B3 (depth 2, parent B2)
    // The last entry in the flat tree is B3 (deeply nested).
    // "Add block" must create a top-level sibling of B1, NOT a sibling of B3.
    act(() => {
      getPageStore('PAGE_1')?.setState({
        blocks: [
          makeBlock({
            id: 'B1',
            content: 'Top-level block',
            parent_id: 'PAGE_1',
            position: 0,
            depth: 0,
          }),
          makeBlock({ id: 'B2', content: 'Nested child', parent_id: 'B1', position: 0, depth: 1 }),
          makeBlock({ id: 'B3', content: 'Deeply nested', parent_id: 'B2', position: 0, depth: 2 }),
        ],
      })
    })

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    // #2849 PR2 — createBelow mints the id CLIENT-side; capture the new block
    // (the one that isn't a pre-seeded B1/B2/B3) rather than expecting 'B4'.
    await waitFor(() => {
      expect(getPageStore('PAGE_1')?.getState().blocks).toHaveLength(4)
    })
    const seeded = new Set(['B1', 'B2', 'B3'])
    const newId = getPageStore('PAGE_1')
      ?.getState()
      .blocks.find((b) => !seeded.has(b.id))?.id
    expect(newId).toBeDefined()

    await waitFor(() => {
      // Must create under PAGE_1 (top-level), not under B2 (nested parent)
      expect(mockedInvoke).toHaveBeenCalledWith(
        'create_block',
        expect.objectContaining({
          blockType: 'content',
          content: '',
          parentId: 'PAGE_1',
          index: 1,
          scope: { kind: 'global' },
          blockId: newId,
        }),
      )
    })

    // Should focus the new (client-id) block
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe(newId)
    })
  })

  it('Add block button shows toast on failure when no blocks exist', async () => {
    const user = userEvent.setup()

    // Per-page store starts empty

    mockedInvoke.mockRejectedValueOnce(new Error('backend error'))

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedToastError).toHaveBeenCalledWith('Failed to create block')
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <PageEditor pageId="PAGE_1" title="Accessible Page" onBack={() => {}} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations without back button', async () => {
    const { container } = render(<PageEditor pageId="PAGE_1" title="No Back Page" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

describe('PageEditor undo/redo integration', () => {
  it('clears undo state for the page on unmount', () => {
    // Seed undo state for the page
    const pages = new Map()
    pages.set('PAGE_1', { redoStack: [], undoDepth: 3 })
    useUndoStore.setState({ pages })

    const { unmount } = render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Undo state exists before unmount
    expect(useUndoStore.getState().pages.has('PAGE_1')).toBe(true)

    unmount()

    // After unmount, clearPage should have removed the entry
    expect(useUndoStore.getState().pages.has('PAGE_1')).toBe(false)
  })

  it('clears undo state for the old page when pageId changes', () => {
    // Seed undo state for both pages
    const pages = new Map()
    pages.set('PAGE_A', { redoStack: [], undoDepth: 2 })
    pages.set('PAGE_B', { redoStack: [], undoDepth: 1 })
    useUndoStore.setState({ pages })

    const { rerender } = render(<PageEditor pageId="PAGE_A" title="Page A" />)

    // PAGE_A state exists
    expect(useUndoStore.getState().pages.has('PAGE_A')).toBe(true)

    // Navigate to PAGE_B — cleanup effect runs for PAGE_A
    rerender(<PageEditor pageId="PAGE_B" title="Page B" />)

    // PAGE_A should be cleared, PAGE_B should still exist
    expect(useUndoStore.getState().pages.has('PAGE_A')).toBe(false)
    expect(useUndoStore.getState().pages.has('PAGE_B')).toBe(true)
  })
})

describe('PageEditor background pointerdown', () => {
  it('pointerdown on page background closes active editor', () => {
    useBlockStore.setState({
      focusedBlockId: 'B1',
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // The outer container has class "page-editor"
    const container = document.querySelector('.page-editor') as HTMLElement
    fireEvent.pointerDown(container)

    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('pointerdown on child element does not close editor', () => {
    useBlockStore.setState({
      focusedBlockId: 'B1',
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    // Click on a child (e.g. the block-tree mock div)
    const child = screen.getByTestId('block-tree')
    fireEvent.pointerDown(child)

    // Should NOT close the editor since target !== currentTarget
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')
  })
})

describe('PageEditor BlockTree auto-creation prop', () => {
  it('renders BlockTree with default autoCreateFirstBlock (not explicitly set)', () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const blockTree = screen.getByTestId('block-tree')
    expect(blockTree).toBeInTheDocument()
    // PageEditor does not pass autoCreateFirstBlock, so BlockTree uses the default (true)
    expect(capturedAutoCreateFirstBlock).toBeUndefined()
  })

  it('manual add block works when page is empty and creates block directly', async () => {
    const user = userEvent.setup()

    // Per-page store starts empty

    // Mock createBlock only — splices the returned row
    // into the per-page store instead of triggering a follow-up list_blocks.
    mockedInvoke.mockResolvedValueOnce({
      id: 'FIRST_BLOCK',
      block_type: 'content',
      content: '',
      parent_id: 'PAGE_1',
      position: 0,
    })

    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const addBtn = screen.getByRole('button', { name: /add block/i })
    await user.click(addBtn)

    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith('create_block', {
        blockType: 'content',
        content: '',
        parentId: 'PAGE_1',
        index: null,
        scope: { kind: 'global' },
        // #2849 PR2 — the empty-page path calls createBlock directly with no
        // client id (createBelow needs an anchor), so the binding sends null.
        blockId: null,
      })
    })

    // Tier 4.2 — no re-list IPC.
    expect(mockedInvoke).not.toHaveBeenCalledWith('list_blocks', expect.anything())

    // Should focus the new block
    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('FIRST_BLOCK')
    })
  })
})

describe('PageEditor date-page panels (B-1)', () => {
  it('renders DuePanel and DonePanel for date-formatted page title', () => {
    render(<PageEditor pageId="PAGE_DATE" title="2026-04-06" />)

    expect(screen.getByTestId('due-panel')).toBeInTheDocument()
    expect(screen.getByTestId('due-panel')).toHaveAttribute('data-date', '2026-04-06')
    expect(screen.getByTestId('done-panel')).toBeInTheDocument()
    expect(screen.getByTestId('done-panel')).toHaveAttribute('data-date', '2026-04-06')
    expect(capturedDuePanelDate).toBe('2026-04-06')
    expect(capturedDonePanelDate).toBe('2026-04-06')
  })

  // #2217 — both panels must receive excludePageId={pageId} so the current
  // date page's own items are filtered out of its Due/Done lists. Previously
  // DuePanel omitted the prop while DonePanel passed it.
  it('passes excludePageId to both DuePanel and DonePanel', () => {
    render(<PageEditor pageId="PAGE_DATE" title="2026-04-06" />)

    expect(screen.getByTestId('due-panel')).toHaveAttribute('data-exclude', 'PAGE_DATE')
    expect(screen.getByTestId('done-panel')).toHaveAttribute('data-exclude', 'PAGE_DATE')
    expect(capturedDuePanelExcludePageId).toBe('PAGE_DATE')
    expect(capturedDonePanelExcludePageId).toBe('PAGE_DATE')
  })

  it('does not render DuePanel/DonePanel for non-date page title', () => {
    render(<PageEditor pageId="PAGE_1" title="My Notes" />)

    expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('done-panel')).not.toBeInTheDocument()
  })

  it('does not render DuePanel/DonePanel for partial date title', () => {
    render(<PageEditor pageId="PAGE_1" title="2026-04" />)

    expect(screen.queryByTestId('due-panel')).not.toBeInTheDocument()
    expect(screen.queryByTestId('done-panel')).not.toBeInTheDocument()
  })
})

// #3276 — navigating to a block hidden under a collapsed ancestor or past the
// mount cap used to be a silent no-op: `target` (the store row) is truthy,
// but `document.querySelector('[data-block-id=...]')` returns null because
// BlockTree never mounted the row, and `clearSelection()` ran anyway —
// burning the one-shot navigation intent with no scroll, no highlight, no
// message.
//
// #4011 — BlockTree is mocked in this file to a plain div (see top of file),
// so these tests drive its `onRevealSettled` callback directly (captured as
// `capturedOnRevealSettled`) instead of simulating DOM mutation across
// animation frames: that IS the real BlockTree's reveal effect reporting its
// outcome, and PageEditor's whole reaction to a slow reveal now runs through
// that one callback.
describe('PageEditor navigation to a block that never mounts (#3276/#4011)', () => {
  it('does not silently drop the navigation intent — surfaces a visible notice when BlockTree reports the target unreachable', async () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    act(() => {
      getPageStore('PAGE_1')?.setState({
        blocks: [
          makeBlock({ id: 'B1', content: 'Target block', parent_id: 'PAGE_1', position: 0 }),
        ],
      })
    })
    act(() => {
      useNavigationStore.setState({ selectedBlockId: 'B1' })
    })

    // Confirms the premise: no row for B1 ever appeared (BlockTree is
    // mocked), so this is genuinely the "never mounts" scenario.
    expect(document.querySelector('[data-block-id="B1"]')).toBeNull()
    // No notice yet — BlockTree has not reported anything.
    expect(mockedToastError).not.toHaveBeenCalled()

    // BlockTree's real reveal effect has determined it cannot show B1 at all
    // (outside the active zoom pane) and reports so.
    act(() => {
      capturedOnRevealSettled?.('B1', false)
    })

    // The important assertion: the app must not just silently clear the
    // intent — it must tell the user. A test that only asserted "does not
    // throw" would pass whether or not this fix exists; this asserts the NEW
    // behavior.
    expect(mockedToastError).toHaveBeenCalledWith(t('error.blockNotFound'))
    // The one-shot intent is cleared alongside the notice, so a stale
    // selectedBlockId can't leak into the next navigation.
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()
  })

  it('still focuses the block in the store even though the DOM row never mounts', async () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    act(() => {
      getPageStore('PAGE_1')?.setState({
        blocks: [
          makeBlock({ id: 'B1', content: 'Target block', parent_id: 'PAGE_1', position: 0 }),
        ],
      })
    })
    act(() => {
      useNavigationStore.setState({ selectedBlockId: 'B1' })
    })

    await waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('B1')
    })
  })

  // A report for an id OTHER than the one currently pending (stale — the
  // navigation intent has since moved on, or already settled) must be
  // ignored: no scroll, no error, no clearing of the CURRENT selection.
  it('ignores an onRevealSettled report for an id that is not the pending reveal', async () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    act(() => {
      getPageStore('PAGE_1')?.setState({
        blocks: [
          makeBlock({ id: 'B1', content: 'Target block', parent_id: 'PAGE_1', position: 0 }),
        ],
      })
    })
    act(() => {
      useNavigationStore.setState({ selectedBlockId: 'B1' })
    })

    act(() => {
      capturedOnRevealSettled?.('SOME_OTHER_ID', false)
    })

    expect(mockedToastError).not.toHaveBeenCalled()
    // B1's reveal is still pending — untouched by the unrelated report.
    expect(useNavigationStore.getState().selectedBlockId).toBe('B1')
  })
})

// #3881/#4011 — the old fixed `MAX_REVEAL_ATTEMPTS = 40` frame cap (and the
// stall-count bound that replaced it) could false-negative a reveal that is
// slow but still legitimately making progress (e.g. a large page whose mount
// cap has to jump hundreds of rows). PageEditor no longer times a reveal out
// at all: it waits for BlockTree's `onRevealSettled` callback, however long
// that takes, and only reacts to what it reports.
describe('PageEditor navigation to a block that mounts late, but legitimately (#3276/#3881/#4011)', () => {
  it('does not report blockNotFound while the reveal is still pending, however many renders that takes', async () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    act(() => {
      getPageStore('PAGE_1')?.setState({
        blocks: [
          makeBlock({ id: 'B1', content: 'Target block', parent_id: 'PAGE_1', position: 0 }),
        ],
      })
    })
    act(() => {
      useNavigationStore.setState({ selectedBlockId: 'B1' })
    })

    // Simulate BlockTree taking many renders/commits to converge — far more
    // than the old 40-frame (or STALL_LIMIT-frame) bound ever allowed —
    // by letting unrelated page state churn a while before the target
    // settles. There is no bound here to exceed anymore, so no notice fires
    // no matter how long this runs.
    for (let i = 0; i < 200; i++) {
      act(() => {
        getPageStore('PAGE_1')?.setState({
          blocks: [
            makeBlock({ id: 'B1', content: 'Target block', parent_id: 'PAGE_1', position: 0 }),
            makeBlock({
              id: `FILLER_${i}`,
              content: 'filler',
              parent_id: 'PAGE_1',
              position: i + 1,
            }),
          ],
        })
      })
    }
    expect(mockedToastError).not.toHaveBeenCalled()
    expect(useNavigationStore.getState().selectedBlockId).toBe('B1')

    // The target row finally mounts and BlockTree reports success.
    const target = document.createElement('div')
    target.setAttribute('data-block-id', 'B1')
    document.body.append(target)
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView')
    act(() => {
      capturedOnRevealSettled?.('B1', true)
    })

    expect(mockedToastError).not.toHaveBeenCalled()
    expect(scrollSpy).toHaveBeenCalled()
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()

    scrollSpy.mockRestore()
    target.remove()
  })

  // The other half of the same contract: a reveal BlockTree has genuinely
  // determined it cannot complete must still surface the notice — waiting
  // forever is not a fix for guessing wrong.
  it('reports blockNotFound once BlockTree confirms the target is unreachable', async () => {
    render(<PageEditor pageId="PAGE_1" title="My Page" />)

    act(() => {
      getPageStore('PAGE_1')?.setState({
        blocks: [
          makeBlock({ id: 'B1', content: 'Target block', parent_id: 'PAGE_1', position: 0 }),
        ],
      })
    })
    act(() => {
      useNavigationStore.setState({ selectedBlockId: 'B1' })
    })

    act(() => {
      capturedOnRevealSettled?.('B1', false)
    })

    expect(mockedToastError).toHaveBeenCalledWith(t('error.blockNotFound'))
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()
  })
})

describe(' responsive layout', () => {
  it('page-editor root has min-w-0 so it can shrink inside a flex parent', () => {
    const { container } = render(<PageEditor pageId="PAGE_1" title="My Page" />)

    const root = container.querySelector('.page-editor') as HTMLElement | null
    expect(root).not.toBeNull()
    expect(root).toHaveClass('min-w-0')
    // Preserve the existing flex-column layout so narrow-viewport behaviour
    // doesn't accidentally change the vertical stacking of children.
    expect(root).toHaveClass('flex')
    expect(root).toHaveClass('flex-col')
  })
})
