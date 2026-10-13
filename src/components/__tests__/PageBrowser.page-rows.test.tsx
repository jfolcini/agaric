// @vitest-environment jsdom
// Split from the PageBrowser.test.tsx monolith (#2929). Concern: page rows
// and the metadata IPC behind them.

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { pageRowInvokeFallback } from '@/__tests__/helpers/invoke'
import { mockReactVirtual } from '@/__tests__/mocks/react-virtual'
import { PageBrowser } from '@/components/PageBrowser'
import { usePageBrowserFiltersStore } from '@/stores/pageBrowserFilters'
import { useSpaceStore } from '@/stores/space'

// Mock @tanstack/react-virtual via the shared helper
// (src/__tests__/mocks/react-virtual.ts) to render all items (jsdom has
// zero-height containers).
vi.mock('@tanstack/react-virtual', () => mockReactVirtual())

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
  sessionStorage.clear()
  localStorage.removeItem('page-browser-sort')
  localStorage.removeItem('starred-pages')
  // Compound-filter chips now live in a module-global per-space store that
  // persists to localStorage (#1750); reset both the in-memory slice and the
  // persisted key so chips added in one test don't leak into the next.
  localStorage.removeItem('agaric:page-browser-filters')
  // An empty slice, not an absent one: absent is the default journal chip (#5370).
  usePageBrowserFiltersStore.setState({ filtersBySpace: { SPACE_TEST: [] }, nextAddId: 0 })
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
    return pageRowInvokeFallback(cmd)
  })
})

describe('PageBrowser', () => {
  describe('page rows', () => {
    /** Shape that mirrors what `list_pages_with_metadata` returns. */
    function makeMetaPage(overrides: {
      id: string
      content: string | null
      lastModifiedAt?: number | null
      inboundLinkCount?: number
      childBlockCount?: number
      flags?: { hasTags: boolean; hasTodo: boolean; hasScheduled: boolean; hasDue: boolean }
    }) {
      return {
        id: overrides.id,
        blockType: 'page',
        content: overrides.content,
        parentId: null,
        position: null,
        deletedAt: null,
        todoState: null,
        priority: null,
        dueDate: null,
        scheduledDate: null,
        pageId: overrides.id,
        lastModifiedAt: overrides.lastModifiedAt ?? null,
        inboundLinkCount: overrides.inboundLinkCount ?? 0,
        childBlockCount: overrides.childBlockCount ?? 0,
        flags: overrides.flags ?? {
          hasTags: false,
          hasTodo: false,
          hasScheduled: false,
          hasDue: false,
        },
      }
    }

    it('calls list_pages_with_metadata (and not list_blocks) on mount', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return pageRowInvokeFallback(cmd)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const metadataCalls = mockedInvoke.mock.calls.filter(
        ([cmd]) => cmd === 'list_pages_with_metadata',
      )
      expect(metadataCalls.length).toBeGreaterThan(0)

      const listBlocksCalls = mockedInvoke.mock.calls.filter(([cmd]) => cmd === 'list_blocks')
      expect(listBlocksCalls).toHaveLength(0)
    })

    it('renders leaf rows via <PageRow>', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return pageRowInvokeFallback(cmd)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Apple')

      expect(container.querySelectorAll('[data-page-item]')).toHaveLength(1)
    })

    it('selecting `most-linked` sort passes `sort: most-linked` to the IPC', async () => {
      const user = userEvent.setup()
      const calls: Array<Record<string, unknown>> = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          calls.push(args as Record<string, unknown>)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple', inboundLinkCount: 3 })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return pageRowInvokeFallback(cmd)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'most-linked')

      await waitFor(() => {
        const seenSorts = calls.map((c) => (c['filter'] as Record<string, unknown>)?.['sort'])
        expect(seenSorts).toContain('most-linked')
      })
    })

    it('selecting `alphabetical` sort maps to the `default` wire enum (frontend-only sort)', async () => {
      const user = userEvent.setup()
      const calls: Array<Record<string, unknown>> = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          calls.push(args as Record<string, unknown>)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return pageRowInvokeFallback(cmd)
      })

      // Seed a non-alphabetical default so we can observe the change
      // back to `alphabetical` triggering a fresh IPC call.
      localStorage.setItem('page-browser-sort', 'most-linked')

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'alphabetical')

      await waitFor(() => {
        // The most recent IPC call should carry `sort: default` because
        // `alphabetical` is the frontend-only re-sort mode.
        const last = calls.at(-1)
        expect(last).toBeDefined()
        const filter = last?.['filter'] as Record<string, unknown> | undefined
        expect(filter?.['sort']).toBe('default')
      })

      localStorage.removeItem('page-browser-sort')
    })

    it('selecting `recently-modified` sort passes `sort: recently-modified` to the IPC', async () => {
      const user = userEvent.setup()
      const calls: Array<Record<string, unknown>> = []
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          calls.push(args as Record<string, unknown>)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
            next_cursor: null,
            has_more: false,
            total_count: 1,
          })
        }
        return pageRowInvokeFallback(cmd)
      })

      render(<PageBrowser />)
      await screen.findByText('Apple')

      const sortSelect = screen.getByRole('combobox', { name: /sort order/i })
      await user.selectOptions(sortSelect, 'recently-modified')

      await waitFor(() => {
        const seenSorts = calls.map((c) => (c['filter'] as Record<string, unknown>)?.['sort'])
        expect(seenSorts).toContain('recently-modified')
      })
    })

    it('RequiresRefresh: cursor recovery retries once with no cursor', async () => {
      // First load: returns page 1 with a next_cursor so the auto-load
      // fires a second IPC. The first cursor-bearing call rejects with
      // an AppError carrying the structured `RequiresRefresh` code (v2 cursor mismatch); the
      // recovery wrapper retries once with `cursor: null`. The retry
      // resolves successfully.
      const cursoredCalls: Array<Record<string, unknown>> = []
      let cursoredCallCount = 0
      mockedInvoke.mockImplementation((cmd: string, args?: unknown) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          const a = (args ?? {}) as Record<string, unknown>
          if (a['cursor'] == null) {
            // Either the initial load or the recovery retry — both
            // resolve normally. Distinguish by whether we've already
            // served a cursor-bearing call.
            if (cursoredCallCount === 0) {
              return Promise.resolve({
                items: [makeMetaPage({ id: 'P1', content: 'Apple' })],
                next_cursor: 'STALE_V1_CURSOR',
                has_more: true,
                total_count: 2,
              })
            }
            // Recovery retry — return the next page-from-the-top.
            cursoredCalls.push(a)
            return Promise.resolve({
              items: [makeMetaPage({ id: 'P2', content: 'Banana' })],
              next_cursor: null,
              has_more: false,
              total_count: 2,
            })
          }
          // Cursor-bearing call → reject with the v2 mismatch error
          // the first time, succeed the second.
          cursoredCallCount += 1
          if (cursoredCallCount === 1) {
            return Promise.reject({
              kind: 'validation',
              code: 'RequiresRefresh',
              message: 'cursor sort mismatch',
            })
          }
          cursoredCalls.push(a)
          return Promise.resolve({
            items: [makeMetaPage({ id: 'P2', content: 'Banana' })],
            next_cursor: null,
            has_more: false,
            total_count: 2,
          })
        }
        return pageRowInvokeFallback(cmd)
      })

      render(<PageBrowser />)

      // Both batches eventually surface despite the v2 cursor rejection.
      await screen.findByText('Apple')
      await waitFor(() => {
        expect(screen.queryByText('Banana')).toBeInTheDocument()
      })

      // The cursor-bearing call rejected once → recovery fired a
      // cursorless retry. Confirm the rejection was observed by counting
      // the cursor-bearing attempts.
      expect(cursoredCallCount).toBeGreaterThanOrEqual(1)
    })

    it('a11y audit passes', async () => {
      mockedInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'resolve_page_by_alias') return Promise.resolve(null)
        if (cmd === 'list_pages_with_metadata') {
          return Promise.resolve({
            items: [
              makeMetaPage({ id: 'P1', content: 'Accessible page' }),
              makeMetaPage({ id: 'P2', content: 'Another page' }),
            ],
            next_cursor: null,
            has_more: false,
            total_count: 2,
          })
        }
        return pageRowInvokeFallback(cmd)
      })

      const { container } = render(<PageBrowser />)
      await screen.findByText('Accessible page')

      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})
