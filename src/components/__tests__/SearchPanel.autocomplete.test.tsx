/**
 * PEND-60 Phase 1 — SearchPanel caret-anchored autocomplete integration.
 *
 * Smaller, focused test file separate from `SearchPanel.test.tsx` so
 * the per-feature surface stays readable. Covers the wire-up between
 * `detectAutocompleteAnchor` + the popover component + the SearchPanel
 * state machine; the popover's own behaviour is covered by
 * `AutocompletePopover.test.tsx` and the detection rules by
 * `autocomplete.test.ts`.
 */

import { invoke } from '@tauri-apps/api/core'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { _resetPropertyKeysCacheForTest } from '../../hooks/usePropertyKeysCache'
import { clearPathHistory, getPathHistory, recordPathHistory } from '../../lib/path-history'
import { useSearchHistoryStore } from '../../stores/search-history'
import { useSpaceStore } from '../../stores/space'
import { useTabsStore } from '../../stores/tabs'
import { SearchPanel } from '../SearchPanel'

vi.mock('../../lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/tauri')>()
  return {
    ...actual,
    resolvePageByAlias: vi.fn().mockResolvedValue(null),
  }
})

const mockedInvoke = vi.mocked(invoke)
const emptyPage = { items: [], next_cursor: null, has_more: false, total_count: null }

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  _resetPropertyKeysCacheForTest()
  clearPathHistory('SPACE_TEST')
  useSearchHistoryStore.setState({ bySpace: {} })
  mockedInvoke.mockResolvedValue(emptyPage)
  useTabsStore.setState({
    tabs: [{ id: '0', pageStack: [], label: '' }],
    activeTabIndex: 0,
  })
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

afterEach(() => {
  vi.useRealTimers()
})

function getInput(): HTMLInputElement {
  return screen.getByPlaceholderText(t('search.searchPlaceholder')) as HTMLInputElement
}

/**
 * happy-dom doesn't synthesise caret-position updates from
 * `fireEvent.change`, so we set both the value and `selectionStart`
 * directly and then dispatch the native input event the way
 * `SearchInput`'s clear helper does. This mirrors how a real keystroke
 * lands at the end of the input.
 */
function typeFull(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.setSelectionRange(value.length, value.length)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('SearchPanel autocomplete (PEND-60 Phase 1)', () => {
  it('opens the popover with state values when the user types `state:`', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    const popover = await screen.findByTestId('autocomplete-popover')
    expect(popover).toBeInTheDocument()
    for (const value of ['TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED', 'none']) {
      expect(screen.getByTestId(`autocomplete-item-${value}`)).toBeInTheDocument()
    }
  })

  it('filters values by what the user typed after the prefix', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:T')

    await screen.findByTestId('autocomplete-item-TODO')
    expect(screen.queryByTestId('autocomplete-item-DOING')).not.toBeInTheDocument()
    expect(screen.queryByTestId('autocomplete-item-DONE')).not.toBeInTheDocument()
  })

  it('inserts the picked value and a trailing space on click', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    const todo = await screen.findByTestId('autocomplete-item-TODO')
    fireEvent.click(todo)

    await waitFor(() => {
      expect(input.value).toBe('state:TODO ')
    })
  })

  it('closes the popover on Escape', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    await screen.findByTestId('autocomplete-popover')
    fireEvent.keyDown(input, { key: 'Escape' })

    await waitFor(() => {
      expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
    })
  })

  it('Enter applies the highlighted value instead of submitting the form', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    await screen.findByTestId('autocomplete-popover')
    // The first item (TODO) is highlighted by default; Enter applies it.
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(input.value).toBe('state:TODO ')
    })
    // The popover dismisses; another typed char re-opens it.
    expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
  })

  it('arrow keys move the highlight without firing history recall', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    await screen.findByTestId('autocomplete-popover')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(input.value).toBe('state:DOING ')
    })
  })

  it('has no a11y violations with the popover open', async () => {
    // The popover's own a11y is audited in AutocompletePopover.test.tsx;
    // here we just confirm the host (input + chip row + status region)
    // stays clean while the popover is mounted via Radix portal.
    const { container } = render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    await screen.findByTestId('autocomplete-popover')
    expect(await axe(container)).toHaveNoViolations()
  })

  // PEND-58g NEW-1 — regex mode still applies structural filters, so the
  // filter-prefix autocomplete must keep working there; only the free-text
  // (= the regex remainder) is self-suppressing because the anchor detector
  // returns null for non-prefix tokens.
  it('regex mode still completes a filter prefix (placeholder reads regex)', async () => {
    render(<SearchPanel />)
    // Flip the regex toggle.
    const regexToggle = screen.getByRole('button', {
      name: new RegExp(t('search.toggle.regex'), 'i'),
    })
    fireEvent.click(regexToggle)

    // In regex mode the input gets the regex-specific placeholder.
    const input = screen.getByPlaceholderText(
      t('search.searchPlaceholderRegex'),
    ) as HTMLInputElement
    input.focus()
    typeFull(input, 'state:')

    // The recognized filter prefix opens the popover even in regex mode.
    const popover = await screen.findByTestId('autocomplete-popover')
    expect(popover).toBeInTheDocument()
    expect(screen.getByTestId('autocomplete-item-TODO')).toBeInTheDocument()
  })

  it('regex mode does NOT complete a free-text (regex remainder) token', async () => {
    render(<SearchPanel />)
    const regexToggle = screen.getByRole('button', {
      name: new RegExp(t('search.toggle.regex'), 'i'),
    })
    fireEvent.click(regexToggle)

    const input = screen.getByPlaceholderText(
      t('search.searchPlaceholderRegex'),
    ) as HTMLInputElement
    input.focus()
    // `^TODO` is free text (the regex remainder), not a recognized filter
    // prefix, so `detectAutocompleteAnchor` returns null and no popover opens.
    typeFull(input, '^TODO')

    await waitFor(() => {
      expect(input.value).toBe('^TODO')
    })
    expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
  })

  it('Tab applies the highlighted value (UX convention)', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'priority:')

    await screen.findByTestId('autocomplete-popover')
    fireEvent.keyDown(input, { key: 'Tab' })

    await waitFor(() => {
      // NEW-4 — priority autocomplete now offers the numeric levels
      // (DEFAULT_PRIORITY_LEVELS = ['1','2','3']), not the stale 'A'/'B'/'C'.
      expect(input.value).toBe('priority:1 ')
    })
  })

  it('wires ARIA combobox attrs and updates aria-activedescendant with the highlight', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()

    // Closed state: combobox role + aria-expanded=false, no aria-controls
    // / aria-activedescendant yet.
    expect(input.getAttribute('role')).toBe('combobox')
    expect(input.getAttribute('aria-autocomplete')).toBe('list')
    expect(input.getAttribute('aria-haspopup')).toBe('listbox')
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input).not.toHaveAttribute('aria-controls')
    expect(input).not.toHaveAttribute('aria-activedescendant')

    typeFull(input, 'state:')
    const popover = await screen.findByTestId('autocomplete-popover')

    // Open: aria-expanded=true and aria-controls / aria-activedescendant
    // point at real DOM ids inside the popover.
    await waitFor(() => {
      expect(input.getAttribute('aria-expanded')).toBe('true')
    })
    const listboxId = input.getAttribute('aria-controls')
    expect(listboxId).toBeTruthy()
    expect(popover.querySelector(`#${listboxId}`)).not.toBeNull()
    const activeId = input.getAttribute('aria-activedescendant')
    expect(activeId).toBeTruthy()
    const active = document.getElementById(activeId ?? '')
    expect(active?.getAttribute('aria-selected')).toBe('true')

    // Moving the highlight updates aria-activedescendant to the new id.
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    await waitFor(() => {
      const nextActive = input.getAttribute('aria-activedescendant')
      expect(nextActive).toBeTruthy()
      expect(nextActive).not.toBe(activeId)
      expect(document.getElementById(nextActive ?? '')?.getAttribute('aria-selected')).toBe('true')
    })
  })

  it('typing after Escape re-opens the popover (dismissal is single-event)', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    await screen.findByTestId('autocomplete-popover')
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
    })

    // Type another character — the dismissal flag resets on the next
    // query change, so the popover should re-appear filtered by the new
    // partial value.
    typeFull(input, 'state:T')
    await screen.findByTestId('autocomplete-popover')
    expect(screen.getByTestId('autocomplete-item-TODO')).toBeInTheDocument()
  })
})

describe('SearchPanel autocomplete dynamic sources (PEND-60 Phase 2)', () => {
  it('surfaces tag suggestions from listTagsByPrefix when typing `tag:#`', async () => {
    vi.useFakeTimers()
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_tags_by_prefix') {
        return [
          { tag_id: 'TAG1', name: 'project-x', color: null },
          { tag_id: 'TAG2', name: 'project-y', color: null },
        ]
      }
      return emptyPage
    })

    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'tag:#pro')

    // Flush the 150 ms debounce inside `useAutocompleteSources`.
    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()

    await screen.findByTestId('autocomplete-popover')
    expect(screen.getByTestId('autocomplete-item-project-x')).toBeInTheDocument()
    expect(screen.getByTestId('autocomplete-item-project-y')).toBeInTheDocument()
  })

  it('surfaces recently-used path globs when typing `path:`', async () => {
    recordPathHistory('SPACE_TEST', 'Journal/*')
    recordPathHistory('SPACE_TEST', 'Archive/2024')

    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'path:')

    await screen.findByTestId('autocomplete-popover')
    expect(screen.getByTestId('autocomplete-item-Journal/*')).toBeInTheDocument()
    expect(screen.getByTestId('autocomplete-item-Archive/2024')).toBeInTheDocument()
  })

  it('records path globs in the per-space MRU on submit', async () => {
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'path:Notes/* hello')
    fireEvent.submit(input.closest('form') as HTMLFormElement)

    await waitFor(() => {
      expect(getPathHistory('SPACE_TEST')).toContain('Notes/*')
    })
  })

  it('syncs caret to end-of-query after history recall', async () => {
    useSearchHistoryStore.getState().push('SPACE_TEST', 'state:DONE older')
    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    // Input is empty -> ArrowUp recalls the most-recent entry through
    // `useSearchHistoryCycling`. Without caret sync the controlled
    // input's selectionStart would lag at 0, causing the autocomplete
    // detector to misread the active anchor.
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    await waitFor(() => {
      expect(input.value).toBe('state:DONE older')
    })
    expect(input.selectionStart).toBe(input.value.length)
    // No spurious popover (caret sits past whitespace -> no anchor).
    expect(screen.queryByTestId('autocomplete-popover')).not.toBeInTheDocument()
  })

  it('surfaces property-key suggestions from listPropertyKeys when typing `prop:`', async () => {
    mockedInvoke.mockImplementation(async (cmd) => {
      if (cmd === 'list_property_keys') return ['status', 'effort', 'owner']
      return emptyPage
    })

    render(<SearchPanel />)
    const input = getInput()
    input.focus()
    typeFull(input, 'prop:')

    await screen.findByTestId('autocomplete-popover')
    expect(screen.getByTestId('autocomplete-item-status')).toBeInTheDocument()
    expect(screen.getByTestId('autocomplete-item-effort')).toBeInTheDocument()
    expect(screen.getByTestId('autocomplete-item-owner')).toBeInTheDocument()
  })
})
