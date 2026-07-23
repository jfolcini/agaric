// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: row-level
// a11y and focus-ring behavior, delete-button interaction state, and small
// keyboard-nav / header-outlet UI details.

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { emptyPage, makePage } from '@/__tests__/fixtures'
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

/** Find the trash (delete) button within a page row via its aria-label. */
function findTrashButton(row: HTMLElement): HTMLButtonElement {
  return within(row).getByRole('button', { name: /delete page/i })
}

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
  it('page item button has focus-visible ring classes', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Focus Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<PageBrowser />)

    await screen.findByText('Focus Page')

    const pageRow = screen.getByText('Focus Page').closest('.group') as HTMLElement
    const pageBtn = within(pageRow).getByRole('button', { name: /Focus Page/i })
    expect(pageBtn.className).toContain('focus-ring-visible')
    // Focus ring must be inset so the inner ScrollArea's
    // `overflow-hidden` does not clip its left/right legs.
    expect(pageBtn).toHaveClass('focus-visible:ring-inset')
  })
  it('focused page row highlights with bg only — focus ring lives on the inner button', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Inset Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<PageBrowser />)

    await screen.findByText('Inset Page')

    // focusedIndex defaults to 0, so the first (and only) virtualized row
    // renders selected with the keyboard-navigation highlight class.
    // `data-page-item` scopes away the native <option> elements in the
    // sort <select> which share role="option".
    const focusedRow = document.querySelector(
      '[data-page-item][aria-selected="true"]',
    ) as HTMLElement | null
    expect(focusedRow).not.toBeNull()
    // Row paints only the highlight background; the focus ring lives on the
    // inner <button>'s `focus-ring-visible` to avoid double-stacking.
    expect(focusedRow).toHaveClass('bg-accent/30')
    expect(focusedRow).not.toHaveClass('ring-2')
    expect(focusedRow).not.toHaveClass('ring-ring/50')

    // The inner button still carries the focus-visible ring so keyboard
    // users see exactly one ring when the row is focused.
    const innerBtn = focusedRow
      ? within(focusedRow).getByRole('button', { name: /Inset Page/i })
      : null
    expect(innerBtn).not.toBeNull()
    expect(innerBtn?.className).toContain('focus-ring-visible')
    expect(innerBtn?.className).toContain('focus-visible:ring-inset')
  })
  it('star-toggle and delete buttons have ring-inset focus rings', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Inset Buttons Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<PageBrowser />)

    await screen.findByText('Inset Buttons Page')

    const pageRow = screen.getByText('Inset Buttons Page').closest('.group') as HTMLElement
    const starBtn = within(pageRow).getByRole('button', { name: /star page/i })
    const deleteBtn = findTrashButton(pageRow)
    expect(starBtn).toHaveClass('focus-visible:ring-inset')
    expect(deleteBtn).toHaveClass('focus-visible:ring-inset')
  })
  it('delete button is disabled while deletion is in progress', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Deleting Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<PageBrowser />)

    await screen.findByText('Deleting Page')

    // Mock delete_block to return a pending promise (never resolves)
    mockedInvoke.mockReturnValueOnce(new Promise(() => {}))

    // Open dialog
    const pageRow = screen.getByText('Deleting Page').closest('.group') as HTMLElement
    const trashBtn = findTrashButton(pageRow)
    await user.click(trashBtn)

    // Click Delete in dialog
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    // Dialog closes but trash button should be disabled while delete is in progress
    await waitFor(() => {
      expect(trashBtn).toBeDisabled()
    })
  })
  it('success toast shown after delete', async () => {
    const user = userEvent.setup()
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'Toast Page' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<PageBrowser />)

    await screen.findByText('Toast Page')

    // Mock delete_block response
    mockedInvoke.mockResolvedValueOnce({
      block_id: 'P1',
      deleted_at: '2025-01-15T00:00:00Z',
      descendants_affected: 0,
    })

    // Open dialog and confirm
    const pageRow = screen.getByText('Toast Page').closest('.group') as HTMLElement
    const trashBtn = findTrashButton(pageRow)
    await user.click(trashBtn)
    const confirmBtn = await screen.findByRole('button', { name: /^Delete$/i })
    await user.click(confirmBtn)

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Page deleted')
    })
  })
  it('page name has title attribute for accessibility', async () => {
    mockedInvoke.mockResolvedValueOnce({
      items: [makePage({ id: 'P1', content: 'A very long page name that should be truncated' })],
      next_cursor: null,
      has_more: false,
      total_count: null,
    })

    render(<PageBrowser />)

    const pageTitle = await screen.findByText('A very long page name that should be truncated')
    expect(pageTitle).toHaveAttribute('title', 'A very long page name that should be truncated')
  })
  describe(' aria-activedescendant on keyboard nav', () => {
    it('grid container exposes aria-activedescendant matching the focused row id', async () => {
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      // focusedIndex defaults to 0 → the first page row is the active
      // descendant. The row carries `id="page-row-{ULID}"`, and the
      // grid points at it via `aria-activedescendant`.
      const grid = screen.getByRole('grid')
      const focusedRow = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(focusedRow).not.toBeNull()
      expect(focusedRow?.id).toBe('page-row-P1')
      expect(grid).toHaveAttribute('aria-activedescendant', 'page-row-P1')
    })

    it('arrow-down updates aria-activedescendant to the next row id', async () => {
      const user = userEvent.setup()
      mockedInvoke.mockResolvedValueOnce({
        items: [
          makePage({ id: 'P1', content: 'Apple' }),
          makePage({ id: 'P2', content: 'Banana' }),
          makePage({ id: 'P3', content: 'Cherry' }),
        ],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const grid = screen.getByRole('grid')
      // Initial state — focus on first page (Apple).
      expect(grid).toHaveAttribute('aria-activedescendant', 'page-row-P1')

      // ArrowDown → focus moves to Banana. The grid's
      // `aria-activedescendant` follows the focused row id.
      await user.keyboard('{ArrowDown}')

      expect(grid).toHaveAttribute('aria-activedescendant', 'page-row-P2')
      const focusedAfter = document.querySelector(
        '[data-page-item][aria-selected="true"]',
      ) as HTMLElement | null
      expect(focusedAfter?.id).toBe('page-row-P2')
      // The id referenced by activedescendant exists in the DOM and
      // matches the row currently flagged as selected.
      expect(grid.getAttribute('aria-activedescendant')).toBe(focusedAfter?.id)
    })
  })
  describe(' header outlet migration', () => {
    // The create-page form + search/sort bar used to live inside a
    // `sticky top-0` wrapper div. It's now hoisted to the App-level outlet
    // via <ViewHeader>; the per-view subtree must not contain the stale
    // sticky-positioning classes. The header content still renders
    // (inline fallback when no provider is present) so existing tests
    // querying the create-page form continue to work.
    it('no sticky top-0 wrapper div, but header content still renders', async () => {
      mockedInvoke.mockResolvedValueOnce(emptyPage)
      const { container } = render(<PageBrowser />)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
      })
      // The old sticky wrapper is gone.
      const sticky = container.querySelector('.sticky.top-0')
      expect(sticky).toBeNull()
      // The new page form is still rendered inline (via ViewHeader fallback).
      expect(screen.getByRole('button', { name: /New Page/i })).toBeInTheDocument()
    })
  })
})
