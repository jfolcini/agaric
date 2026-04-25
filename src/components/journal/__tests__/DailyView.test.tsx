/**
 * Tests for DailyView component.
 *
 * Validates:
 *  1. Renders a single DaySection with correct props
 *  2. Passes entry, onNavigateToPage, and onAddBlock through
 *  3. DaySection receives headingLevel="h2", hideHeading, mode="daily"
 *  4. Has no a11y violations
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { DayEntry } from '../../../lib/date-utils'

// ── Mock DaySection ─────────────────────────────────────────────────
const daySectionProps = vi.hoisted(() => ({
  captured: [] as Record<string, unknown>[],
}))

vi.mock('../DaySection', () => ({
  DaySection: (props: Record<string, unknown>) => {
    daySectionProps.captured.push(props)
    const entry = props['entry'] as DayEntry
    return (
      <section
        data-testid="day-section"
        data-date={entry.dateStr}
        data-heading-level={props['headingLevel'] as string}
        data-hide-heading={String(props['hideHeading'])}
        data-mode={props['mode'] as string}
        aria-label={`Journal for ${entry.displayDate}`}
      >
        <span>{entry.displayDate}</span>
        {!!props['onNavigateToPage'] && (
          <button
            type="button"
            data-testid="navigate-btn"
            onClick={() =>
              (props['onNavigateToPage'] as (pageId: string, title?: string) => void)(
                'PAGE_1',
                'Test',
              )
            }
          >
            Navigate
          </button>
        )}
        <button
          type="button"
          data-testid="add-block-btn"
          onClick={() => (props['onAddBlock'] as (dateStr: string) => void)(entry.dateStr)}
        >
          Add block
        </button>
      </section>
    )
  },
}))

vi.mocked(invoke)

import { useBlockStore } from '../../../stores/blocks'
import { useNavigationStore } from '../../../stores/navigation'
import { DailyView } from '../DailyView'

const ENTRY: DayEntry = {
  date: new Date(2025, 0, 15),
  dateStr: '2025-01-15',
  displayDate: 'Wed, Jan 15, 2025',
  pageId: 'PAGE_1',
}

const ENTRY_NO_PAGE: DayEntry = {
  date: new Date(2025, 0, 16),
  dateStr: '2025-01-16',
  displayDate: 'Thu, Jan 16, 2025',
  pageId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  daySectionProps.captured = []
})

describe('DailyView', () => {
  it('renders a DaySection for the given entry', () => {
    render(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    expect(screen.getByTestId('day-section')).toBeInTheDocument()
    expect(screen.getByText('Wed, Jan 15, 2025')).toBeInTheDocument()
  })

  it('passes correct props to DaySection', () => {
    const onAddBlock = vi.fn()
    const onNavigateToPage = vi.fn()

    render(<DailyView entry={ENTRY} onNavigateToPage={onNavigateToPage} onAddBlock={onAddBlock} />)

    expect(screen.getByTestId('day-section')).toHaveAttribute('data-heading-level', 'h2')
    expect(screen.getByTestId('day-section')).toHaveAttribute('data-hide-heading', 'true')
    expect(screen.getByTestId('day-section')).toHaveAttribute('data-mode', 'daily')
    expect(screen.getByTestId('day-section')).toHaveAttribute('data-date', '2025-01-15')
  })

  it('forwards onNavigateToPage callback', async () => {
    const user = userEvent.setup()
    const onNavigateToPage = vi.fn()

    render(<DailyView entry={ENTRY} onNavigateToPage={onNavigateToPage} onAddBlock={vi.fn()} />)

    await user.click(screen.getByTestId('navigate-btn'))
    expect(onNavigateToPage).toHaveBeenCalledWith('PAGE_1', 'Test')
  })

  it('forwards onAddBlock callback with dateStr', async () => {
    const user = userEvent.setup()
    const onAddBlock = vi.fn()

    render(<DailyView entry={ENTRY} onAddBlock={onAddBlock} />)

    await user.click(screen.getByTestId('add-block-btn'))
    expect(onAddBlock).toHaveBeenCalledWith('2025-01-15')
  })

  it('renders without onNavigateToPage (optional prop)', () => {
    render(<DailyView entry={ENTRY_NO_PAGE} onAddBlock={vi.fn()} />)

    expect(screen.getByTestId('day-section')).toBeInTheDocument()
    expect(screen.queryByTestId('navigate-btn')).not.toBeInTheDocument()
  })

  it('renders exactly one DaySection', () => {
    render(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    const sections = screen.getAllByTestId('day-section')
    expect(sections).toHaveLength(1)
  })

  it('applies fade animation keyed on date', () => {
    const { container } = render(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('animate-in')
    expect(wrapper.className).toContain('fade-in-0')
    expect(wrapper.className).toContain('duration-150')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <DailyView entry={ENTRY} onNavigateToPage={vi.fn()} onAddBlock={vi.fn()} />,
    )
    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })
})

// ── UX-258 — scroll selectedBlockId into view + restore focus on mount ────
describe('DailyView UX-258 selectedBlockId scroll-into-view', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>
  const seededElements: HTMLElement[] = []

  function seedBlockElement(id: string): HTMLElement {
    const el = document.createElement('div')
    el.setAttribute('data-block-id', id)
    document.body.appendChild(el)
    seededElements.push(el)
    return el
  }

  beforeEach(() => {
    vi.clearAllMocks()
    scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    useNavigationStore.setState({ selectedBlockId: null })
    useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  })

  afterEach(() => {
    scrollSpy.mockRestore()
    while (seededElements.length > 0) {
      const el = seededElements.pop()
      el?.parentNode?.removeChild(el)
    }
  })

  it('scrolls matching block into view, sets focus, and clears selectedBlockId on arming', async () => {
    seedBlockElement('BLOCK_X')
    useNavigationStore.setState({ selectedBlockId: 'BLOCK_X' })

    render(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    // The rAF callback runs asynchronously; wait for scrollIntoView to be invoked.
    await vi.waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest' })
    })

    await vi.waitFor(() => {
      expect(useBlockStore.getState().focusedBlockId).toBe('BLOCK_X')
    })

    // selectedBlockId is cleared synchronously inside the effect.
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()
  })

  it('clears selectedBlockId without scrolling when the DOM node is absent', async () => {
    useNavigationStore.setState({ selectedBlockId: 'MISSING_BLOCK' })

    render(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    // The effect calls clearSelection() synchronously — assertion is safe immediately.
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()

    // Drain one rAF tick so any scheduled callback runs and we can prove no scroll fired.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('is a no-op when selectedBlockId is null', async () => {
    useNavigationStore.setState({ selectedBlockId: null })

    render(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    expect(scrollSpy).not.toHaveBeenCalled()
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
    expect(useNavigationStore.getState().selectedBlockId).toBeNull()
  })

  it('scroll fires exactly once per arming — re-renders do not re-trigger', async () => {
    seedBlockElement('BLOCK_Y')
    useNavigationStore.setState({ selectedBlockId: 'BLOCK_Y' })

    const { rerender } = render(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    await vi.waitFor(() => {
      expect(scrollSpy).toHaveBeenCalledTimes(1)
    })

    // selectedBlockId has been cleared by the first arming. A forced re-render
    // must not re-fire the effect because its dep value is now null.
    rerender(<DailyView entry={ENTRY} onAddBlock={vi.fn()} />)

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })

    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })
})
