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

  it('regex mode disables the popover', async () => {
    render(<SearchPanel />)
    // Flip the regex toggle.
    const regexToggle = screen.getByRole('button', {
      name: new RegExp(t('search.toggle.regex'), 'i'),
    })
    fireEvent.click(regexToggle)

    const input = getInput()
    input.focus()
    typeFull(input, 'state:')

    // The popover gate hangs off `currentAnchor`, which becomes null
    // synchronously when `toggles.isRegex` is true — no popover should
    // ever render. Assert absence after the input dispatch has flushed.
    await waitFor(() => {
      expect(input.value).toBe('state:')
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
      expect(input.value).toBe('priority:A ')
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
