/**
 * Tests for `PageBrowserHeader` (Phase 2 extension).
 *
 * Coverage:
 *   1. All 6 `SortOption` items are reachable via the sort select.
 *   2. `axe(container)` reports no a11y violations.
 *   3. The view buttons (#5269) open their views and the Trash button
 *      carries the trash count.
 *   4. Search first (#5637): the first row is search, sort, saved views and
 *      New page; search is the primary focus only with a fine pointer.
 *   5. Phone (#5927): one row of search, sort, a ⋮ menu holding saved views
 *      and the view buttons, and New page.
 *
 * Radix Select is globally mocked to a native `<select>` tree in
 * `src/test-setup.ts`, so `userEvent.selectOptions` drives the
 * sort select directly. The trigger's `aria-label` is forwarded onto
 * the native `<select>` by the mock, which gives us a stable handle
 * by accessible name.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  PageBrowserHeader,
  type PageBrowserHeaderProps,
} from '@/components/PageBrowser/PageBrowserHeader'
import { useIsMobile } from '@/hooks/useIsMobile'
import { PrimaryFocusProvider, usePrimaryFocusRegistry } from '@/hooks/usePrimaryFocus'
import { t } from '@/lib/i18n'
import { OPEN_NEW_PAGE_DIALOG_EVENT } from '@/lib/overlay-events'
import { useNavigationStore } from '@/stores/navigation'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: vi.fn(() => false) }))

function makeProps(overrides: Partial<PageBrowserHeaderProps> = {}): PageBrowserHeaderProps {
  return {
    showSortAndViews: true,
    filterText: '',
    onFilterTextChange: vi.fn(),
    sortOption: 'alphabetical',
    onSortChange: vi.fn(),
    savedViews: [],
    activeSavedView: null,
    onApplySavedView: vi.fn(),
    onDeleteSavedView: vi.fn(),
    onSaveCurrentView: vi.fn(),
    ...overrides,
  }
}

describe('PageBrowserHeader', () => {
  it('exposes all 6 sort modes in the sort select', () => {
    render(<PageBrowserHeader {...makeProps()} />)

    const sortSelect = screen.getByRole('combobox', {
      name: t('pageBrowser.sortLabel'),
    })
    // The mocked Select renders <option>s as direct children; the test
    // pulls the option values to verify the union is fully surfaced, in order.
    const options = Array.from(sortSelect.querySelectorAll('option')).map((opt) => opt.value)
    expect(options).toEqual([
      'alphabetical',
      'recent',
      'created',
      'recently-modified',
      'most-linked',
      'most-content',
    ])
  })

  it('fires onSortChange when a new sort mode is selected', async () => {
    const onSortChange = vi.fn()
    render(<PageBrowserHeader {...makeProps({ onSortChange })} />)

    const sortSelect = screen.getByRole('combobox', {
      name: t('pageBrowser.sortLabel'),
    })
    await userEvent.selectOptions(sortSelect, 'most-linked')

    expect(onSortChange).toHaveBeenCalledWith('most-linked')
  })

  it('has no axe violations', async () => {
    const { container } = render(<PageBrowserHeader {...makeProps()} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // ── / T-F1 — count-label branches ──────────────────────
  //
  // The chip pairs a numerator and denominator that must share a basis:
  //  (a) no chips, no text → `countAll`     ("312 pages")
  //  (b) free-text query   → `countFiltered`("23 of 312 matching")
  //  (c) chips, no text    → `countMatching`("312 matching pages")
  //  (·) null total        → no chip at all
  describe('count-label branches (T-F1)', () => {
    it('renders no count chip when totalCount is undefined', () => {
      render(<PageBrowserHeader {...makeProps({ totalCount: undefined })} />)
      expect(screen.queryByTestId('page-browser-count')).not.toBeInTheDocument()
    })

    it('renders the countAll form when no text and no chip filters are active', () => {
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            hasTextQuery: false,
            hasChipFilters: false,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countAll', { count: 312 }))
    })

    it('renders the countFiltered form when a free-text query is active', () => {
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            filteredCount: 23,
            hasTextQuery: true,
            hasChipFilters: false,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countFiltered', { loaded: 23, total: 312 }))
    })

    it('renders the countMatching form when chips are active without a text query', () => {
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            filteredCount: 312,
            hasTextQuery: false,
            hasChipFilters: true,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countMatching', { count: 312 }))
    })

    it('text query takes precedence over chips (countFiltered, not countMatching)', () => {
      // Both axes active: the free-text box is the inner narrowing, so the
      // chip shows "X of Y matching" (the loaded-narrowed numerator) rather
      // than the chip-only single-number form.
      render(
        <PageBrowserHeader
          {...makeProps({
            totalCount: 312,
            filteredCount: 5,
            hasTextQuery: true,
            hasChipFilters: true,
          })}
        />,
      )
      const chip = screen.getByTestId('page-browser-count')
      expect(chip).toHaveTextContent(t('pageBrowser.countFiltered', { loaded: 5, total: 312 }))
      expect(chip).not.toHaveTextContent(t('pageBrowser.countMatching', { count: 312 }))
    })
  })

  // ── search first (#5637) ──────────────────────────────
  describe('search first', () => {
    it('the first row is search, sort, saved views, then New page, and it wraps', () => {
      const { container } = render(<PageBrowserHeader {...makeProps()} />)
      const firstRow = container.querySelector('.page-browser-header > div') as HTMLElement
      // `flex-wrap` stacks the controls on a narrow viewport instead of overflowing.
      expect(firstRow).toHaveClass('flex-wrap')
      const inRow = within(firstRow)
      const order = [
        inRow.getByRole('textbox', { name: t('pageBrowser.searchPlaceholder') }),
        inRow.getByRole('combobox', { name: t('pageBrowser.sortLabel') }),
        inRow.getByRole('button', { name: t('pageBrowser.savedViews.trigger') }),
        inRow.getByRole('button', { name: t('pageBrowser.newPage') }),
      ]
      for (let i = 1; i < order.length; i++) {
        const prev = order[i - 1] as HTMLElement
        expect(prev.compareDocumentPosition(order[i] as HTMLElement)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        )
      }
    })

    it('with no pages, search and New page stay but sort and saved views go', () => {
      render(<PageBrowserHeader {...makeProps({ showSortAndViews: false })} />)
      expect(
        screen.getByRole('textbox', { name: t('pageBrowser.searchPlaceholder') }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: t('pageBrowser.newPage') })).toBeInTheDocument()
      expect(screen.queryByRole('combobox', { name: t('pageBrowser.sortLabel') })).toBeNull()
      expect(screen.queryByRole('button', { name: t('pageBrowser.savedViews.trigger') })).toBeNull()
    })

    it('with no pages the saved views stay reachable but cannot save one', async () => {
      const user = userEvent.setup()
      const onApplySavedView = vi.fn()
      const view = {
        id: 'v1',
        name: 'Recent work',
        createdAt: '2026-01-01T00:00:00Z',
        sort: 'recent' as const,
        filters: [],
      }
      render(
        <PageBrowserHeader
          {...makeProps({ showSortAndViews: false, savedViews: [view], onApplySavedView })}
        />,
      )

      await user.click(screen.getByRole('button', { name: t('pageBrowser.savedViews.trigger') }))
      const menu = await screen.findByTestId('saved-views-menu')
      expect(within(menu).queryByTestId('saved-views-save-current')).toBeNull()
      await user.click(
        within(menu).getByRole('button', {
          name: t('pageBrowser.savedViews.apply', { name: 'Recent work' }),
        }),
      )
      expect(onApplySavedView).toHaveBeenCalledWith(view)
    })

    it('New page opens the New page dialog with no title', async () => {
      const user = userEvent.setup()
      const opened: string[] = []
      const listener = (e: Event) => opened.push((e as CustomEvent<string>).detail)
      window.addEventListener(OPEN_NEW_PAGE_DIALOG_EVENT, listener)
      try {
        render(<PageBrowserHeader {...makeProps()} />)
        await user.click(screen.getByRole('button', { name: t('pageBrowser.newPage') }))
      } finally {
        window.removeEventListener(OPEN_NEW_PAGE_DIALOG_EVENT, listener)
      }
      expect(opened).toEqual([''])
    })

    /** Focuses the view's registered primary element once, as App does on a view change. */
    function FocusOnEntry(): null {
      const registry = usePrimaryFocusRegistry()
      useEffect(() => {
        registry?.focus()
      }, [registry])
      return null
    }

    function renderEntering() {
      return render(
        <PrimaryFocusProvider>
          <PageBrowserHeader {...makeProps()} />
          <FocusOnEntry />
        </PrimaryFocusProvider>,
      )
    }

    it('search takes focus on entry with a fine pointer', () => {
      renderEntering()
      expect(
        screen.getByRole('textbox', { name: t('pageBrowser.searchPlaceholder') }),
      ).toHaveFocus()
    })

    it('search does not take focus on entry under a coarse pointer', () => {
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query === '(pointer: coarse)',
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
          }) as unknown as MediaQueryList,
      )
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
      try {
        renderEntering()
        expect(
          screen.getByRole('textbox', { name: t('pageBrowser.searchPlaceholder') }),
        ).not.toHaveFocus()
        expect(document.activeElement).toBe(document.body)
      } finally {
        vi.restoreAllMocks()
        Object.defineProperty(navigator, 'maxTouchPoints', { value: 0, configurable: true })
      }
    })
  })

  // ── view buttons (#5269) ──────────────────────────────
  describe('view buttons', () => {
    const VIEW_BUTTONS = [
      ['sidebar.tags', 'tags'],
      ['sidebar.graph', 'graph'],
      ['sidebar.query', 'query'],
      ['sidebar.templates', 'templates'],
      ['sidebar.trash', 'trash'],
    ] as const

    /** Render with an active space whose `count_trash` answers with `countTrash`. */
    async function renderWithTrash(countTrash: () => number) {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
      vi.mocked(invoke).mockImplementation(mockInvokeCommands({ count_trash: countTrash }))
      const result = render(<PageBrowserHeader {...makeProps()} />)
      await waitFor(() => {
        expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'count_trash')).toBe(true)
      })
      // Let the count land in state before asserting on its absence.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
      return result
    }

    beforeEach(() => {
      useNavigationStore.setState({ currentView: 'pages' })
    })

    afterEach(() => {
      vi.mocked(invoke).mockReset()
      useSpaceStore.setState({ currentSpaceId: null })
    })

    it.each(VIEW_BUTTONS)('%s opens the %s view', async (labelKey, view) => {
      const user = userEvent.setup()
      render(<PageBrowserHeader {...makeProps()} />)

      await user.click(screen.getByRole('button', { name: t(labelKey) }))

      expect(useNavigationStore.getState().currentView).toBe(view)
    })

    it('the Trash button shows the trash count as a badge', async () => {
      await renderWithTrash(() => 3)
      const trash = screen.getByRole('button', {
        name: t('pageBrowser.viewButtons.trashWithCount', { count: 3 }),
      })
      expect(within(trash).getByText('3')).toBeInTheDocument()
    })

    it('the Trash button shows no badge when the trash is empty', async () => {
      await renderWithTrash(() => 0)
      const trash = screen.getByRole('button', { name: t('sidebar.trash') })
      expect(trash.querySelector('[data-slot="badge"]')).toBeNull()
    })

    it('the Trash button shows no badge when count_trash rejects', async () => {
      await renderWithTrash(() => {
        throw new Error('boom')
      })
      const trash = screen.getByRole('button', { name: t('sidebar.trash') })
      expect(trash.querySelector('[data-slot="badge"]')).toBeNull()
    })

    it('has no axe violations with the trash badge present', async () => {
      const { container } = await renderWithTrash(() => 3)
      expect(
        screen.getByRole('button', {
          name: t('pageBrowser.viewButtons.trashWithCount', { count: 3 }),
        }),
      ).toBeInTheDocument()
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  // ── phone (#5927) ──────────────────────────────────────
  describe('on a phone', () => {
    const MENU_VIEWS = [
      ['sidebar.tags', 'tags'],
      ['sidebar.graph', 'graph'],
      ['sidebar.query', 'query'],
      ['sidebar.templates', 'templates'],
      ['sidebar.trash', 'trash'],
    ] as const

    beforeEach(() => {
      vi.mocked(useIsMobile).mockReturnValue(true)
      useNavigationStore.setState({ currentView: 'pages' })
    })

    afterEach(() => {
      vi.mocked(useIsMobile).mockReturnValue(false)
    })

    it('keeps one row: search, sort, the ⋮ menu and New page, with no count or view row', () => {
      const { container } = render(<PageBrowserHeader {...makeProps({ totalCount: 12 })} />)
      const rows = container.querySelectorAll('.page-browser-header > div')
      expect(rows).toHaveLength(1)
      const row = rows[0] as HTMLElement
      expect(row).not.toHaveClass('flex-wrap')
      const inRow = within(row)
      const order = [
        inRow.getByRole('textbox', { name: t('pageBrowser.searchPlaceholder') }),
        inRow.getByRole('combobox', { name: t('pageBrowser.sortLabel') }),
        inRow.getByRole('button', { name: t('pageBrowser.moreMenu') }),
        inRow.getByRole('button', { name: t('pageBrowser.newPage') }),
      ]
      for (let i = 1; i < order.length; i++) {
        const prev = order[i - 1] as HTMLElement
        expect(prev.compareDocumentPosition(order[i] as HTMLElement)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING,
        )
      }
      expect(screen.queryByTestId('page-browser-count')).toBeNull()
      expect(screen.queryByRole('button', { name: t('pageBrowser.savedViews.trigger') })).toBeNull()
      expect(screen.queryByRole('button', { name: t('sidebar.graph') })).toBeNull()
    })

    it('the ⋮ menu holds the saved views', async () => {
      const user = userEvent.setup()
      const onApplySavedView = vi.fn()
      const view = {
        id: 'v1',
        name: 'Recent work',
        createdAt: '2026-01-01T00:00:00Z',
        sort: 'recent' as const,
        filters: [],
      }
      render(<PageBrowserHeader {...makeProps({ savedViews: [view], onApplySavedView })} />)

      await user.click(screen.getByRole('button', { name: t('pageBrowser.moreMenu') }))
      const menu = await screen.findByTestId('saved-views-menu')
      expect(within(menu).getByText(t('pageBrowser.savedViews.trigger'))).toBeInTheDocument()
      expect(within(menu).getByTestId('saved-views-save-current')).toBeInTheDocument()
      await user.click(
        within(menu).getByRole('button', {
          name: t('pageBrowser.savedViews.apply', { name: 'Recent work' }),
        }),
      )
      expect(onApplySavedView).toHaveBeenCalledWith(view)
    })

    it('with no pages the ⋮ menu keeps the saved views but cannot save one', async () => {
      const user = userEvent.setup()
      const onDeleteSavedView = vi.fn()
      const view = {
        id: 'v1',
        name: 'Recent work',
        createdAt: '2026-01-01T00:00:00Z',
        sort: 'recent' as const,
        filters: [],
      }
      render(
        <PageBrowserHeader
          {...makeProps({ showSortAndViews: false, savedViews: [view], onDeleteSavedView })}
        />,
      )

      await user.click(screen.getByRole('button', { name: t('pageBrowser.moreMenu') }))
      const menu = await screen.findByTestId('saved-views-menu')
      expect(within(menu).queryByTestId('saved-views-save-current')).toBeNull()
      await user.click(
        within(menu).getByRole('button', {
          name: t('pageBrowser.savedViews.delete', { name: 'Recent work' }),
        }),
      )
      expect(onDeleteSavedView).toHaveBeenCalledWith(view)
      await user.click(within(menu).getByRole('button', { name: t('sidebar.graph') }))
      expect(useNavigationStore.getState().currentView).toBe('graph')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    })

    it.each(MENU_VIEWS)(
      'the ⋮ menu item %s opens the %s view and closes',
      async (labelKey, view) => {
        const user = userEvent.setup()
        render(<PageBrowserHeader {...makeProps()} />)

        await user.click(screen.getByRole('button', { name: t('pageBrowser.moreMenu') }))
        const menu = await screen.findByTestId('saved-views-menu')
        await user.click(within(menu).getByRole('button', { name: t(labelKey) }))

        expect(useNavigationStore.getState().currentView).toBe(view)
        await waitFor(() => expect(screen.queryByTestId('saved-views-menu')).toBeNull())
      },
    )

    it('the ⋮ menu names the trash count', async () => {
      useSpaceStore.setState({ currentSpaceId: 'SPACE_TEST' })
      vi.mocked(invoke).mockImplementation(mockInvokeCommands({ count_trash: () => 4 }))
      try {
        const user = userEvent.setup()
        render(<PageBrowserHeader {...makeProps()} />)
        await waitFor(() => {
          expect(vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === 'count_trash')).toBe(true)
        })
        await user.click(screen.getByRole('button', { name: t('pageBrowser.moreMenu') }))
        const menu = await screen.findByTestId('saved-views-menu')
        expect(
          await within(menu).findByRole('button', {
            name: t('pageBrowser.viewButtons.trashWithCount', { count: 4 }),
          }),
        ).toBeInTheDocument()
      } finally {
        vi.mocked(invoke).mockReset()
        useSpaceStore.setState({ currentSpaceId: null })
      }
    })

    it('has no axe violations with the ⋮ menu open', async () => {
      const user = userEvent.setup()
      const { container } = render(<PageBrowserHeader {...makeProps()} />)
      await user.click(screen.getByRole('button', { name: t('pageBrowser.moreMenu') }))
      const menu = await screen.findByTestId('saved-views-menu')
      expect(await axe(container)).toHaveNoViolations()
      expect(await axe(menu)).toHaveNoViolations()
    })
  })
})
