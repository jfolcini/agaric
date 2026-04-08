/**
 * Tests for SuggestionList component.
 *
 * Validates:
 *  - Rendering items as option buttons
 *  - Default selection state (first item)
 *  - Empty state ("No results")
 *  - Click to select an item
 *  - Pointer enter updates selection
 *  - Imperative ref keyboard navigation (ArrowDown, ArrowUp, Enter)
 *  - Wrap-around navigation (last→first, first→last)
 *  - "Create" item styling with isCreate flag
 *  - Selection reset when items change
 *  - a11y compliance
 */

import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import type { PickerItem, SuggestionListRef } from '../SuggestionList'
import { SuggestionList } from '../SuggestionList'

const sampleItems: PickerItem[] = [
  { id: '1', label: 'Alpha' },
  { id: '2', label: 'Beta' },
  { id: '3', label: 'Gamma' },
]

function makeKeyEvent(key: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('SuggestionList', () => {
  it('renders items as buttons with role="option"', () => {
    const command = vi.fn()
    render(<SuggestionList items={sampleItems} command={command} />)

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]).toHaveTextContent('Alpha')
    expect(options[1]).toHaveTextContent('Beta')
    expect(options[2]).toHaveTextContent('Gamma')
  })

  it('first item is selected by default (aria-selected=true)', () => {
    const command = vi.fn()
    render(<SuggestionList items={sampleItems} command={command} />)

    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
    expect(options[1]).toHaveAttribute('aria-selected', 'false')
    expect(options[2]).toHaveAttribute('aria-selected', 'false')
  })

  it('shows "No results" when items array is empty', () => {
    const command = vi.fn()
    render(<SuggestionList items={[]} command={command} />)

    expect(screen.getByText('No results')).toBeInTheDocument()
    expect(screen.queryByRole('option')).not.toBeInTheDocument()
  })

  it('clicking an item calls command with that item', async () => {
    const user = userEvent.setup()
    const command = vi.fn()
    render(<SuggestionList items={sampleItems} command={command} />)

    const betaBtn = screen.getByText('Beta')
    await user.click(betaBtn)

    expect(command).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith(sampleItems[1])
  })

  it('pointer enter updates selected index', async () => {
    const user = userEvent.setup()
    const command = vi.fn()
    render(<SuggestionList items={sampleItems} command={command} />)

    // Initially first item is selected
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    // Hover over second item
    await user.hover(options[1] as HTMLElement)

    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')
  })

  it('ArrowDown via imperative ref moves selection down', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    // First item selected by default
    expect(screen.getByText('Alpha')).toHaveAttribute('aria-selected', 'true')

    // ArrowDown → Beta
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
      expect(handled).toBe(true)
    })

    expect(screen.getByText('Beta')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Alpha')).toHaveAttribute('aria-selected', 'false')
  })

  it('ArrowDown wraps from last to first', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    // Move to last item (ArrowDown twice: 0→1→2)
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })

    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'true')

    // One more ArrowDown should wrap to first
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })

    expect(screen.getByText('Alpha')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'false')
  })

  it('ArrowUp wraps from first to last', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    // First item selected by default
    expect(screen.getByText('Alpha')).toHaveAttribute('aria-selected', 'true')

    // ArrowUp at first item should wrap to last
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('ArrowUp') })
      expect(handled).toBe(true)
    })

    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Alpha')).toHaveAttribute('aria-selected', 'false')
  })

  it('Enter via imperative ref calls command with selected item', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    // Move to Beta (ArrowDown once)
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })

    // Press Enter
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('Enter') })
      expect(handled).toBe(true)
    })

    expect(command).toHaveBeenCalledOnce()
    expect(command).toHaveBeenCalledWith(sampleItems[1])
  })

  it('renders "Create" item styling with isCreate=true', () => {
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: '1', label: 'Existing Page' },
      { id: 'create-new', label: 'My New Page', isCreate: true },
    ]

    render(<SuggestionList items={items} command={command} />)

    // The create button (2nd option) should contain "Create <strong>label</strong>"
    const createBtn = screen.getAllByRole('option')[1] as HTMLElement
    expect(createBtn).toHaveTextContent('Create My New Page')

    // Verify the strong element for the label
    const strongEl = createBtn.querySelector('strong')
    expect(strongEl).toBeInTheDocument()
    expect(strongEl).toHaveTextContent('My New Page')

    // Verify the Plus icon (lucide-react) is rendered with text-primary
    const plusIcon = createBtn.querySelector('.text-primary')
    expect(plusIcon).toBeInTheDocument()

    // Verify the border-t and bg-accent/5 styling classes are applied on the button
    expect(createBtn.className).toContain('border-t')
    expect(createBtn.className).toContain('bg-accent/5')
  })

  it('resets selected index when items change', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    const { rerender } = render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    // Move selection to index 2 (Gamma)
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })

    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'true')

    // Re-render with new items
    const newItems: PickerItem[] = [
      { id: '4', label: 'Delta' },
      { id: '5', label: 'Epsilon' },
    ]
    rerender(<SuggestionList ref={ref} items={newItems} command={command} />)

    // Selection should reset to first item
    expect(screen.getByText('Delta')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('Epsilon')).toHaveAttribute('aria-selected', 'false')
  })

  it('unrecognised key returns false from onKeyDown', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    let handled: boolean | undefined
    act(() => {
      handled = ref.current?.onKeyDown({ event: makeKeyEvent('Tab') })
    })

    expect(handled).toBe(false)
    // Selection unchanged
    expect(screen.getByText('Alpha')).toHaveAttribute('aria-selected', 'true')
  })

  it('has no a11y violations', async () => {
    const command = vi.fn()
    const { container } = render(<SuggestionList items={sampleItems} command={command} />)

    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('scrolls the selected item into view on keyboard navigation', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    // Mock scrollIntoView on all option elements
    const options = screen.getAllByRole('option')
    for (const option of options) {
      option.scrollIntoView = vi.fn()
    }

    // ArrowDown → Beta becomes selected
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })

    // The newly selected item (Beta) should have scrollIntoView called
    expect(options[1]?.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })

  // -- ARIA label ---------------------------------------------------------------

  it('renders default aria-label "Suggestions" on the listbox when no label prop is passed', () => {
    const command = vi.fn()
    render(<SuggestionList items={sampleItems} command={command} />)

    const listbox = screen.getByRole('listbox')
    expect(listbox).toHaveAttribute('aria-label', 'Suggestions')
  })

  it('renders custom aria-label on the listbox when label prop is provided', () => {
    const command = vi.fn()
    render(<SuggestionList items={sampleItems} command={command} label="Tags" />)

    const listbox = screen.getByRole('listbox')
    expect(listbox).toHaveAttribute('aria-label', 'Tags')
  })

  // -- Empty state hardening ---------------------------------------------------

  it('onKeyDown returns false for all keys when items are empty', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={[]} command={command} />)

    for (const key of ['ArrowUp', 'ArrowDown', 'Enter']) {
      let handled: boolean | undefined
      act(() => {
        handled = ref.current?.onKeyDown({ event: makeKeyEvent(key) })
      })
      expect(handled).toBe(false)
    }

    expect(command).not.toHaveBeenCalled()
  })

  it('"No results" element has status role and aria-live="polite"', () => {
    const command = vi.fn()
    render(<SuggestionList items={[]} command={command} />)

    const el = screen.getByRole('status')
    expect(el).toHaveTextContent('No results')
    expect(el).toHaveAttribute('aria-live', 'polite')
  })

  // -- UX-66: Popup animation --------------------------------------------------

  it('popup container has "suggestion-list" class for CSS animation (UX-66)', () => {
    const command = vi.fn()
    render(<SuggestionList items={sampleItems} command={command} />)

    const listbox = screen.getByRole('listbox')
    expect(listbox.className).toContain('suggestion-list')
  })

  // -- UX-67: "Create new" prominence ------------------------------------------

  it('"Create new" item renders a Plus SVG icon with text-primary class (UX-67)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: '1', label: 'Existing Page' },
      { id: 'create-new', label: 'My New Page', isCreate: true },
    ]

    render(<SuggestionList items={items} command={command} />)

    const createBtn = screen.getAllByRole('option')[1] as HTMLElement

    // Should contain an SVG (lucide Plus icon) with text-primary
    const svgIcon = createBtn.querySelector('svg.text-primary')
    expect(svgIcon).toBeInTheDocument()
  })
})
