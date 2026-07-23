// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: the
// namespaced pages tree view.

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { makePage } from '@/__tests__/fixtures'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { PageBrowser } from '@/components/PageBrowser'
import { usePageBrowserFiltersStore } from '@/stores/pageBrowserFilters'
import { useSpaceStore } from '@/stores/space'

// Capture every `estimateSize` callback passed to `useVirtualizer` so the
// Referential-stability test can assert the function identity
// is unchanged across re-renders that don't change `groupedRows`.
//
// The captured signature is the production one (`(index: number) => number`),
// but the mock invokes it without args throughout this test file (legacy
// Zero-arg invocation predates the change). The `(...args: never[])`
// type lets both calling conventions type-check cleanly without `any`.
type EstimateSizeFn = (...args: never[]) => number
const capturedEstimateSizes: Array<EstimateSizeFn> = []

// PageBrowser pagination UX (2026-05-14) — `vi.mock` is hoisted to
// the top of the file before module-level `const`s, so a mock that
// references a captured spy has to declare the spy via
// `vi.hoisted(…)` (which IS hoisted alongside the mocks).
const { scrollToOffsetMock } = vi.hoisted(() => ({
  scrollToOffsetMock: vi.fn(),
}))

// Mock @tanstack/react-virtual via the shared helper
// (src/__tests__/mocks/react-virtual.ts) to render all items (jsdom has
// zero-height containers). `onEstimateSize` captures each estimator so the
// size assertions can replay it; `scrollToOffset` uses the hoisted spy so the
// scroll-restoration test can assert it fired with the saved offset
// (PageBrowser pagination UX 2026-05-14).
vi.mock('@tanstack/react-virtual', () =>
  mockReactVirtual({
    onEstimateSize: (estimateSize) => capturedEstimateSizes.push(estimateSize as EstimateSizeFn),
    scrollToOffset: scrollToOffsetMock,
  }),
)

// Radix Select is mocked globally via the shared mock in src/test-setup.ts
// (see src/__tests__/mocks/ui-select.tsx).

// #1149 — recent-pages moved from `lib/recent-pages` to the zustand store.
// Override only the snapshot reader the PageBrowser sort/grouping uses;
// keep every other store export real (the full PageBrowser render pulls in
// `useRecentPagesStore`, `QuickAccessBar`, etc.).
vi.mock('@/stores/recent-pages', async (importActual) => {
  const actual = await importActual<typeof import('@/stores/recent-pages')>()
  return { ...actual, getRecentPagesForSpace: vi.fn(() => []) }
})

const mockedInvoke = vi.mocked(invoke)

beforeEach(() => {
  vi.clearAllMocks()
  capturedEstimateSizes.length = 0
  scrollToOffsetMock.mockClear()
  // PageBrowser pagination UX (2026-05-14) — scroll-restoration tests
  // round-trip values through sessionStorage; isolate each test.
  sessionStorage.clear()
  localStorage.removeItem('page-browser-sort')
  localStorage.removeItem('page-browser-density')
  localStorage.removeItem('starred-pages')
  // Compound-filter chips now live in a module-global per-space store that
  // persists to localStorage (#1750); reset both the in-memory slice and the
  // persisted key so chips added in one test don't leak into the next.
  localStorage.removeItem('agaric:page-browser-filters')
  usePageBrowserFiltersStore.setState({ filtersBySpace: {}, nextAddId: 0 })
  // Phase 2 — PageBrowser now gates its render and page query
  // on `useSpaceStore.isReady`. Seed the store so tests exercise the
  // real code path rather than the loading skeleton.
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [
      { id: 'SPACE_TEST', name: 'Test', accent_color: null },
      { id: 'SPACE_OTHER', name: 'Other', accent_color: null },
    ],
    isReady: true,
  })
  // Default fallback: resolve_page_by_alias returns null (no alias match)
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
    return Promise.resolve(undefined)
  })
})

describe('PageBrowser', () => {
  it('has no a11y violations', async () => {
    const page = {
      items: [makePage({ id: 'P1', content: 'Accessible page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockResolvedValueOnce(page)

    const { container } = render(<PageBrowser />)

    // Wait for the rendered page before auditing — wrapping axe() in
    // waitFor() retries the (slow) audit each tick and reliably blows
    // past the 1s default. Direct findByText is the settle signal.
    await screen.findByText('Accessible page')
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
  describe('namespaced pages tree view', () => {
    it('renders flat list when no pages have namespaces', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'First page' }),
          makePage({ id: 'P2', content: 'Second page' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      expect(await screen.findByText('First page')).toBeInTheDocument()
      expect(screen.getByText('Second page')).toBeInTheDocument()
      // Should use flat list items (row role inside grid; tree-page
      // wrappers are absent when no namespaces exist).
      const grid = screen.getByRole('grid')
      const listItems = within(grid)
        .getAllByRole('row')
        .filter((r) => r.hasAttribute('data-page-item'))
      expect(listItems).toHaveLength(2)
    })

    it('renders tree structure for namespaced pages', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
          makePage({ id: 'P3', content: 'personal/journal' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      // Namespace folders should appear
      expect(await screen.findByText('work')).toBeInTheDocument()
      expect(screen.getByText('personal')).toBeInTheDocument()

      // Leaf page names should appear (just the segment, not full path)
      expect(screen.getByText('project-a')).toBeInTheDocument()
      expect(screen.getByText('project-b')).toBeInTheDocument()
      expect(screen.getByText('journal')).toBeInTheDocument()
    })

    it('namespace folders are collapsible', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      // Wait for tree to render — children should be visible (expanded by default)
      expect(await screen.findByText('project-a')).toBeInTheDocument()
      expect(screen.getByText('project-b')).toBeInTheDocument()

      // Click the "work" folder button to collapse it
      const workFolder = screen.getByText('work')
      await user.click(workFolder)

      // Children should be hidden
      expect(screen.queryByText('project-a')).not.toBeInTheDocument()
      expect(screen.queryByText('project-b')).not.toBeInTheDocument()

      // Folder label still visible
      expect(screen.getByText('work')).toBeInTheDocument()

      // Click again to expand
      await user.click(workFolder)

      // Children should reappear
      expect(screen.getByText('project-a')).toBeInTheDocument()
      expect(screen.getByText('project-b')).toBeInTheDocument()
    })

    it('fires onPageSelect with full path when a tree leaf is clicked', async () => {
      const user = userEvent.setup()
      const onPageSelect = vi.fn()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser onPageSelect={onPageSelect} />)

      const leaf = await screen.findByText('project-a')
      await user.click(leaf)

      expect(onPageSelect).toHaveBeenCalledWith('P1', 'work/project-a')
    })

    it('renders hybrid node (page with children) as navigable folder', async () => {
      const user = userEvent.setup()
      const onPageSelect = vi.fn()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work' }),
          makePage({ id: 'P2', content: 'work/project-a' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser onPageSelect={onPageSelect} />)

      // "work" should be visible as a clickable name
      const workName = await screen.findByText('work')
      expect(workName).toBeInTheDocument()

      // "project-a" child should be visible (expanded by default)
      expect(screen.getByText('project-a')).toBeInTheDocument()

      // Clicking the "work" name should navigate to the work page
      await user.click(workName)
      expect(onPageSelect).toHaveBeenCalledWith('P1', 'work')
    })

    it('hybrid node can be collapsed to hide children', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work' }),
          makePage({ id: 'P2', content: 'work/project-a' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      // Children should be visible initially
      expect(await screen.findByText('project-a')).toBeInTheDocument()

      // Find the chevron toggle button (sibling of the name button)
      const workName = screen.getByText('work')
      const headerRow = workName.closest('.group') as HTMLElement
      const buttons = within(headerRow).getAllByRole('button')
      // First button is the chevron toggle
      const chevronBtn = buttons[0] as HTMLElement
      await user.click(chevronBtn)

      // Children should be hidden
      expect(screen.queryByText('project-a')).not.toBeInTheDocument()

      // Folder label still visible
      expect(screen.getByText('work')).toBeInTheDocument()

      // Click again to expand
      await user.click(chevronBtn)
      expect(screen.getByText('project-a')).toBeInTheDocument()
    })

    it('tree leaf items have a delete button that triggers confirmation dialog', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'work/project-a' }),
          makePage({ id: 'P2', content: 'work/project-b' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('project-a')

      // Find the delete button for project-a via aria-label
      const deleteBtn = screen.getByRole('button', { name: 'Delete work/project-a' })
      expect(deleteBtn).toBeInTheDocument()

      await user.click(deleteBtn)

      // Confirmation dialog should appear
      expect(await screen.findByText(/Delete page\?/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /^Delete$/i })).toBeInTheDocument()
    })

    // Delete is destructive — Cancel must be auto-focused so reflex
    // Enter dismisses instead of permanently deleting the page. We assert
    // focus state + no-mutation rather than dialog dismissal alone, because
    // jsdom's autoFocus + Radix focus-trap timing can lag the Enter event.
    it('reflex Enter on delete dialog does NOT call trash_page', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('project-a')

      const deleteBtn = screen.getByRole('button', { name: 'Delete work/project-a' })
      await user.click(deleteBtn)
      expect(await screen.findByText(/Delete page\?/i)).toBeInTheDocument()

      // Wait for Cancel to receive focus (autoFocus is applied in a
      // post-mount effect by Radix).
      const cancelBtn = screen.getByRole('button', { name: /Cancel/i })
      await waitFor(() => {
        expect(cancelBtn).toHaveFocus()
      })

      // Reflex Enter on the focused Cancel button must NOT trigger the
      // destructive action.
      await user.keyboard('{Enter}')

      // No mutation IPC should have fired.
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'trash_page')).toHaveLength(0)
      expect(mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'delete_page')).toHaveLength(0)
    })

    it('tree leaf items render with a file icon', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [makePage({ id: 'P1', content: 'work/project-a' })],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)

      await screen.findByText('project-a')

      // The leaf item should contain an SVG icon (FileText from lucide-react)
      const leafButton = screen.getByText('project-a').closest('button') as HTMLElement
      const svg = leafButton.querySelector('svg')
      expect(svg).toBeInTheDocument()
      expect(svg?.classList.contains('h-4')).toBe(true)
      expect(svg?.classList.contains('w-4')).toBe(true)
    })
  })
})
