/**
 * Tests StreamView — the continuous infinite-scroll journal stream (#1415).
 *
 * Validates:
 * 1. Renders today first (top-anchored) plus older days in descending order.
 * 2. Today gets headingLevel="h2", older days "h3"; all are mode="stream",
 *    compact, and lazyMount (virtualized — DaySection mounts BlockTree only
 *    once a day enters the viewport).
 * 3. Sentinel intersection calls `loadOlder()` (scroll loads older days).
 * 4. Empty days (pageId === null) still render a DaySection (with its empty
 *    state) and never mount a BlockTree.
 * 5. Loading skeleton on first load; "reached start" footer at the horizon.
 * 6. No a11y violations.
 * 7. Mount window (#2670): StreamView wires a `useDayMountWindow` LRU into
 *    every `DaySection` — scrolling past `STREAM_MOUNT_WINDOW` days keeps
 *    the mounted set bounded (oldest evicted first), a previously-evicted
 *    day remounts when scrolled back to, and a day with focus inside it is
 *    protected from eviction.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { STREAM_MOUNT_WINDOW } from '@/hooks/useDayMountWindow'
import type { DayEntry } from '@/lib/date-utils'
import { formatDate } from '@/lib/date-utils'

// ── Mock the data hook so dates/loading/horizon are deterministic ────
const mockStream = vi.hoisted(() => ({
  dates: [] as Date[],
  pageMap: new Map<string, string>(),
  loading: false,
  loadingOlder: false,
  reachedEnd: false,
  loadOlder: vi.fn(),
  addPage: vi.fn(),
}))

vi.mock('@/hooks/useStreamDates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useStreamDates')>()
  return { ...actual, useStreamDates: () => mockStream }
})

// ── Mock block creation (no IPC) ──────────────────────────────────────
const mockHandleAddBlock = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useJournalBlockCreation', () => ({
  useJournalBlockCreation: () => ({
    createdPages: new Map<string, string>(),
    handleAddBlock: mockHandleAddBlock,
  }),
}))

// ── Mock DaySection to a thin probe carrying its props ────────────────
// Also surfaces the `mountWindow` prop StreamView wires in (#2670): an
// "enter-{dateStr}" button simulates that day's own IntersectionObserver
// firing (real `DaySection` reports every entry via `markVisible`), and
// `data-mounted` reflects `mountWindow.isMounted(entry.dateStr)` so tests
// can assert the bound without re-implementing DaySection's real observer
// plumbing (that's covered by DaySection.test.tsx's own `mountWindow`
// suite). The `id` mirrors real DaySection's `journal-${dateStr}` section id
// — StreamView's focus-eviction guard looks elements up by that id.
vi.mock('@/components/journal/DaySection', () => ({
  DaySection: (props: Record<string, unknown>) => {
    const entry = props['entry'] as DayEntry
    const mountWindow = props['mountWindow'] as
      | { isMounted: (key: string) => boolean; markVisible: (key: string) => void }
      | undefined
    const mounted = mountWindow ? mountWindow.isMounted(entry.dateStr) : true
    return (
      <section
        id={`journal-${entry.dateStr}`}
        data-testid={`day-section-${entry.dateStr}`}
        data-heading-level={props['headingLevel'] as string}
        data-compact={String(!!props['compact'])}
        data-mode={props['mode'] as string}
        data-lazy-mount={String(!!props['lazyMount'])}
        data-has-page={String(entry.pageId != null)}
        data-mounted={String(mounted)}
      >
        {entry.displayDate}
        {mountWindow && (
          <button
            type="button"
            data-testid={`enter-${entry.dateStr}`}
            onClick={() => mountWindow.markVisible(entry.dateStr)}
          >
            enter
          </button>
        )}
        {mounted && (
          <input data-testid={`focusable-${entry.dateStr}`} aria-label={`edit ${entry.dateStr}`} />
        )}
      </section>
    )
  },
}))

vi.mock('@/components/rendering/LoadingSkeleton', () => ({
  LoadingSkeleton: () => <div data-testid="loading-skeleton" />,
}))

// ── Controllable IntersectionObserver capturing the callback ──────────
let lastObserverCallback: IntersectionObserverCallback | null = null
let observedEl: Element | null = null

class TestIntersectionObserver {
  constructor(cb: IntersectionObserverCallback) {
    lastObserverCallback = cb
  }
  observe(el: Element): void {
    observedEl = el
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

/** Simulate the sentinel entering the viewport. */
function fireIntersection(isIntersecting: boolean): void {
  lastObserverCallback?.(
    [{ isIntersecting, target: observedEl } as unknown as IntersectionObserverEntry],
    {} as IntersectionObserver,
  )
}

import { StreamView } from '@/components/journal/StreamView'

const TODAY = new Date(2026, 5, 20) // Sat, Jun 20, 2026
function d(year: number, month1: number, day: number): Date {
  return new Date(year, month1 - 1, day)
}
function entryDates(): Date[] {
  return [d(2026, 6, 20), d(2026, 6, 19), d(2026, 6, 18)]
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(TODAY)
  lastObserverCallback = null
  observedEl = null
  globalThis.IntersectionObserver =
    TestIntersectionObserver as unknown as typeof globalThis.IntersectionObserver
  mockStream.dates = entryDates()
  mockStream.pageMap = new Map([
    ['2026-06-20', 'page-today'],
    ['2026-06-19', 'page-yesterday'],
    // 2026-06-18 intentionally absent → empty day
  ])
  mockStream.loading = false
  mockStream.loadingOlder = false
  mockStream.reachedEnd = false
})

afterEach(() => {
  vi.useRealTimers()
})

describe('StreamView', () => {
  it('renders today first (top-anchored) then older days descending', () => {
    render(<StreamView />)
    const sections = screen.getAllByTestId(/^day-section-/)
    expect(sections.map((s) => s.getAttribute('data-testid'))).toEqual([
      'day-section-2026-06-20',
      'day-section-2026-06-19',
      'day-section-2026-06-18',
    ])
  })

  it('marks today h2 and older days h3, all stream/compact/lazyMount', () => {
    render(<StreamView />)
    const today = screen.getByTestId('day-section-2026-06-20')
    expect(today).toHaveAttribute('data-heading-level', 'h2')
    const older = screen.getByTestId('day-section-2026-06-19')
    expect(older).toHaveAttribute('data-heading-level', 'h3')
    for (const s of screen.getAllByTestId(/^day-section-/)) {
      expect(s).toHaveAttribute('data-mode', 'stream')
      expect(s).toHaveAttribute('data-compact', 'true')
      // Virtualization: BlockTree mounts lazily on viewport entry.
      expect(s).toHaveAttribute('data-lazy-mount', 'true')
    }
  })

  it('renders an empty day (no page) as a DaySection without a page', () => {
    render(<StreamView />)
    const emptyDay = screen.getByTestId('day-section-2026-06-18')
    expect(emptyDay).toHaveAttribute('data-has-page', 'false')
    expect(screen.getByTestId('day-section-2026-06-20')).toHaveAttribute('data-has-page', 'true')
  })

  it('calls loadOlder when the sentinel intersects (scroll loads older days)', () => {
    render(<StreamView />)
    expect(mockStream.loadOlder).not.toHaveBeenCalled()
    fireIntersection(true)
    expect(mockStream.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('does not call loadOlder when the sentinel is not intersecting', () => {
    render(<StreamView />)
    fireIntersection(false)
    expect(mockStream.loadOlder).not.toHaveBeenCalled()
  })

  it('shows a loading skeleton (no day sections) on first load', () => {
    mockStream.loading = true
    mockStream.dates = []
    render(<StreamView />)
    expect(screen.getByTestId('stream-loading')).toBeInTheDocument()
    expect(screen.queryByTestId(/^day-section-/)).not.toBeInTheDocument()
  })

  it('shows the reached-start footer and no sentinel at the horizon', () => {
    mockStream.reachedEnd = true
    render(<StreamView />)
    expect(screen.getByTestId('stream-end')).toBeInTheDocument()
    expect(screen.queryByTestId('stream-sentinel')).not.toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = render(<StreamView />)
    expect(await axe(container)).toHaveNoViolations()
  })

  // ── Mount window (#2670) ─────────────────────────────────────────────
  describe('mount window bound', () => {
    /** `n` consecutive days, most-recent (today) first — mirrors useStreamDates' order. */
    function nDaysBack(n: number): Date[] {
      return Array.from({ length: n }, (_, i) => d(2026, 6, 20 - i))
    }

    function setupDays(n: number): Date[] {
      const dates = nDaysBack(n)
      mockStream.dates = dates
      mockStream.pageMap = new Map(dates.map((dt) => [formatDate(dt), `page-${formatDate(dt)}`]))
      return dates
    }

    /** Simulate every listed day's own IntersectionObserver firing, in order. */
    function enterAll(dates: Date[]): void {
      for (const dt of dates) {
        act(() => {
          fireEvent.click(screen.getByTestId(`enter-${formatDate(dt)}`))
        })
      }
    }

    function isMountedDay(dt: Date): boolean {
      return (
        screen.getByTestId(`day-section-${formatDate(dt)}`).getAttribute('data-mounted') === 'true'
      )
    }

    it('passes a mountWindow controller to every DaySection', () => {
      setupDays(3)
      render(<StreamView />)
      for (const dt of mockStream.dates) {
        expect(screen.getByTestId(`enter-${formatDate(dt)}`)).toBeInTheDocument()
      }
    })

    it('bounds the mounted day count at STREAM_MOUNT_WINDOW after scrolling past many more days', () => {
      const dates = setupDays(STREAM_MOUNT_WINDOW + 5)
      render(<StreamView />)

      enterAll(dates)

      const mountedCount = dates.filter(isMountedDay).length
      expect(mountedCount).toBe(STREAM_MOUNT_WINDOW)
    })

    it('evicts the oldest-visited days first, keeping the most-recently-visited window mounted', () => {
      const dates = setupDays(STREAM_MOUNT_WINDOW + 5)
      render(<StreamView />)

      enterAll(dates)

      const expectedMounted = new Set(dates.slice(-STREAM_MOUNT_WINDOW).map((dt) => formatDate(dt)))
      for (const dt of dates) {
        expect(isMountedDay(dt)).toBe(expectedMounted.has(formatDate(dt)))
      }
    })

    it('re-mounts a previously-evicted day when scrolled back to', () => {
      const dates = setupDays(STREAM_MOUNT_WINDOW + 2)
      render(<StreamView />)

      enterAll(dates)
      const firstDay = dates[0]
      expect(firstDay).toBeDefined()
      if (!firstDay) return
      expect(isMountedDay(firstDay)).toBe(false) // evicted — it was visited first

      // Scroll back up to the first day.
      act(() => {
        fireEvent.click(screen.getByTestId(`enter-${formatDate(firstDay)}`))
      })

      expect(isMountedDay(firstDay)).toBe(true)
    })

    it('protects a day with focus inside it from eviction', () => {
      const dates = setupDays(STREAM_MOUNT_WINDOW + 2)
      render(<StreamView />)

      const firstDay = dates[0]
      expect(firstDay).toBeDefined()
      if (!firstDay) return
      const firstDateStr = formatDate(firstDay)

      // Enter the first day, then focus an element inside it.
      act(() => {
        fireEvent.click(screen.getByTestId(`enter-${firstDateStr}`))
      })
      const focusable = screen.getByTestId(`focusable-${firstDateStr}`)
      focusable.focus()
      expect(document.activeElement).toBe(focusable)

      // Scroll through the rest — normally enough to evict the first day.
      enterAll(dates.slice(1))

      // Still mounted: the focus guard protected it.
      expect(screen.getByTestId(`day-section-${firstDateStr}`)).toHaveAttribute(
        'data-mounted',
        'true',
      )
    })
  })
})
