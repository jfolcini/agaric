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
    const { container } = render(<SuggestionList items={sampleItems} command={command} />)

    // The animation/popover shell class is applied to the outer popup container
    // (ancestor of the listbox). UX-207 moved the inner list inside a ScrollArea
    // so the animation now lives on the outer shell rather than the listbox.
    const popup = container.querySelector('.suggestion-list')
    expect(popup).toBeInTheDocument()

    // Sanity: the listbox is inside the popup shell.
    const listbox = screen.getByRole('listbox')
    expect(popup).toContainElement(listbox)
  })

  // -- UX-207: ScrollArea wrapper replaces bare overflow-y-auto -----------------

  it('wraps the list in a ScrollArea (no bare overflow-y-auto) (UX-207)', () => {
    const command = vi.fn()
    const { container } = render(<SuggestionList items={sampleItems} command={command} />)

    // The list is rendered inside a ScrollArea viewport (Radix primitive).
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]')
    expect(viewport).toBeInTheDocument()

    // The listbox role lives on a child of the viewport.
    const listbox = screen.getByRole('listbox')
    expect(viewport).toContainElement(listbox)

    // No element should carry a bare `overflow-y-auto` class anymore.
    const anyOverflowY = container.querySelector('.overflow-y-auto')
    expect(anyOverflowY).toBeNull()
  })

  it('keyboard navigation still scrolls the selected item into view under ScrollArea (UX-207)', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    const options = screen.getAllByRole('option')
    for (const option of options) {
      option.scrollIntoView = vi.fn()
    }

    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })

    // scrollIntoView is called on the newly selected option. The browser
    // resolves the nearest scroll container — the ScrollArea viewport — on its
    // own; the component doesn't need to identify the scrolling ancestor.
    expect(options[1]?.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
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

  // -- UX-50: Category grouping and icons --------------------------------------

  it('renders category headers when items have categories (UX-50)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: '1', label: 'TODO', category: 'slashCommand.categories.tasks' },
      { id: '2', label: 'DOING', category: 'slashCommand.categories.tasks' },
      { id: '3', label: 'DATE', category: 'slashCommand.categories.dates' },
    ]

    render(<SuggestionList items={items} command={command} />)

    const categoryHeaders = screen.getAllByTestId('suggestion-category')
    expect(categoryHeaders).toHaveLength(2)
    expect(categoryHeaders[0]).toHaveTextContent('Tasks')
    expect(categoryHeaders[1]).toHaveTextContent('Dates')
  })

  it('renders icons inline before item labels (UX-50)', () => {
    const command = vi.fn()
    const MockIcon = ({ className }: { className?: string | undefined }) => (
      <svg data-testid="mock-icon" className={className} />
    )
    const items: PickerItem[] = [
      { id: '1', label: 'TODO', icon: MockIcon, category: 'slashCommand.categories.tasks' },
    ]

    render(<SuggestionList items={items} command={command} />)

    const icon = screen.getByTestId('mock-icon')
    expect(icon).toBeInTheDocument()
    const cls = icon.getAttribute('class') ?? ''
    expect(cls).toContain('h-4')
    expect(cls).toContain('w-4')
    expect(cls).toContain('text-muted-foreground')
  })

  it('does not show empty category headers when filtering removes all items in a group (UX-50)', () => {
    const command = vi.fn()
    // Simulate a filtered result where only "Tasks" items match
    const items: PickerItem[] = [
      { id: '1', label: 'TODO', category: 'slashCommand.categories.tasks' },
    ]

    render(<SuggestionList items={items} command={command} />)

    const categoryHeaders = screen.getAllByTestId('suggestion-category')
    expect(categoryHeaders).toHaveLength(1)
    expect(categoryHeaders[0]).toHaveTextContent('Tasks')
    // "Dates" category should not appear at all
    expect(screen.queryByText('Dates')).not.toBeInTheDocument()
  })

  it('keyboard navigation works across category groups (UX-50)', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: '1', label: 'TODO', category: 'slashCommand.categories.tasks' },
      { id: '2', label: 'DATE', category: 'slashCommand.categories.dates' },
      { id: '3', label: 'LINK', category: 'slashCommand.categories.references' },
    ]

    render(<SuggestionList ref={ref} items={items} command={command} />)

    // First item selected by default
    const options = screen.getAllByRole('option')
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    // ArrowDown moves to next item across categories
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    expect(options[1]).toHaveAttribute('aria-selected', 'true')

    // ArrowDown again
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    expect(options[2]).toHaveAttribute('aria-selected', 'true')

    // Enter selects the item
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('Enter') })
    })
    expect(command).toHaveBeenCalledWith(items[2])
  })

  it('renders separator between category groups but not before the first group (UX-50)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: '1', label: 'TODO', category: 'slashCommand.categories.tasks' },
      { id: '2', label: 'DATE', category: 'slashCommand.categories.dates' },
      { id: '3', label: 'CODE', category: 'slashCommand.categories.structure' },
    ]

    render(<SuggestionList items={items} command={command} />)

    const separators = screen.getAllByRole('separator')
    // Should have separators between groups (2 separators for 3 groups)
    expect(separators).toHaveLength(2)
  })

  it('does not render category headers for items without categories (UX-50)', () => {
    const command = vi.fn()
    // Plain items without categories (like tag picker items)
    render(<SuggestionList items={sampleItems} command={command} />)

    expect(screen.queryByTestId('suggestion-category')).not.toBeInTheDocument()
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
  })

  // -- UX-65: Breadcrumbs -------------------------------------------------------

  it('renders breadcrumb text below the label when present (UX-65)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [{ id: '1', label: 'standup', breadcrumb: 'work / meetings' }]

    render(<SuggestionList items={items} command={command} />)

    expect(screen.getByText('standup')).toBeInTheDocument()
    const breadcrumb = screen.getByTestId('suggestion-breadcrumb')
    expect(breadcrumb).toBeInTheDocument()
    expect(breadcrumb).toHaveTextContent('work / meetings')
    expect(breadcrumb.className).toContain('text-xs')
    expect(breadcrumb.className).toContain('text-muted-foreground')
  })

  it('does not render breadcrumb when not present (UX-65)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [{ id: '1', label: 'Simple Item' }]

    render(<SuggestionList items={items} command={command} />)

    expect(screen.getByText('Simple Item')).toBeInTheDocument()
    expect(screen.queryByTestId('suggestion-breadcrumb')).not.toBeInTheDocument()
  })

  it('renders icon with breadcrumb together (UX-65)', () => {
    const command = vi.fn()
    const MockIcon = ({ className }: { className?: string | undefined }) => (
      <svg data-testid="breadcrumb-icon" className={className} />
    )
    const items: PickerItem[] = [
      { id: '1', label: 'standup', breadcrumb: 'work / meetings', icon: MockIcon },
    ]

    render(<SuggestionList items={items} command={command} />)

    expect(screen.getByTestId('breadcrumb-icon')).toBeInTheDocument()
    expect(screen.getByText('standup')).toBeInTheDocument()
    expect(screen.getByTestId('suggestion-breadcrumb')).toHaveTextContent('work / meetings')
  })

  // -- UX-219: Truncated labels and breadcrumbs expose full text via title -----

  it('adds title={item.label} to the label span when the item has a breadcrumb (UX-219)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: '1', label: 'work/2024/q1/very-long-name', breadcrumb: 'workspace / personal' },
    ]

    render(<SuggestionList items={items} command={command} />)

    const labelEl = screen.getByText('work/2024/q1/very-long-name')
    expect(labelEl).toHaveAttribute('title', 'work/2024/q1/very-long-name')
  })

  it('adds title={item.breadcrumb} to the breadcrumb span (UX-219)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [
      { id: '1', label: 'standup', breadcrumb: 'workspace / team / very / deep / path' },
    ]

    render(<SuggestionList items={items} command={command} />)

    const breadcrumb = screen.getByTestId('suggestion-breadcrumb')
    expect(breadcrumb).toHaveAttribute('title', 'workspace / team / very / deep / path')
  })

  it('does not add title attribute to items without a breadcrumb (UX-219)', () => {
    const command = vi.fn()
    const items: PickerItem[] = [{ id: '1', label: 'simple label' }]

    render(<SuggestionList items={items} command={command} />)

    // The label is rendered inline (no breadcrumb structure). It must not
    // carry a stray `title` — we only add it when the truncate class is present.
    const labelEl = screen.getByText('simple label')
    expect(labelEl).not.toHaveAttribute('title')
  })

  // =========================================================================
  // Home/End and PageUp/PageDown keyboard navigation (UX-138)
  // =========================================================================

  it('Home key moves selection to first item, End to last via imperative ref', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    render(<SuggestionList ref={ref} items={sampleItems} command={command} />)

    // Move to last item
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    act(() => {
      ref.current?.onKeyDown({ event: makeKeyEvent('ArrowDown') })
    })
    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'true')

    // Home should go to first
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('Home') })
      expect(handled).toBe(true)
    })
    expect(screen.getByText('Alpha')).toHaveAttribute('aria-selected', 'true')

    // End should go to last
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('End') })
      expect(handled).toBe(true)
    })
    expect(screen.getByText('Gamma')).toHaveAttribute('aria-selected', 'true')
  })

  it('PageDown/PageUp navigate through items via imperative ref', () => {
    const ref = createRef<SuggestionListRef>()
    const command = vi.fn()
    const manyItems: PickerItem[] = Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      label: `Item ${i}`,
    }))
    render(<SuggestionList ref={ref} items={manyItems} command={command} />)

    // First item selected by default
    expect(screen.getByText('Item 0')).toHaveAttribute('aria-selected', 'true')

    // PageDown should jump forward by 10
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('PageDown') })
      expect(handled).toBe(true)
    })
    expect(screen.getByText('Item 10')).toHaveAttribute('aria-selected', 'true')

    // PageUp should jump back by 10
    act(() => {
      const handled = ref.current?.onKeyDown({ event: makeKeyEvent('PageUp') })
      expect(handled).toBe(true)
    })
    expect(screen.getByText('Item 0')).toHaveAttribute('aria-selected', 'true')
  })
})
