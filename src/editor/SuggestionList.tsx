/**
 * Shared suggestion popup component for # and [[ pickers.
 *
 * Rendered via ReactRenderer (outside the main React tree).
 * Keyboard navigation (ArrowUp/Down, Enter) forwarded from
 * the Suggestion plugin via the imperative ref.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

/** An item in the suggestion popup (tag or page). */
export interface PickerItem {
  id: string
  label: string
  /** When true, selecting this item creates a new page instead of linking to an existing one. */
  isCreate?: boolean
}

export interface SuggestionListProps {
  items: PickerItem[]
  command: (item: PickerItem) => void
  /** Accessible label for the suggestion listbox (e.g. "Tags", "Block links"). */
  label?: string
}

export interface SuggestionListRef {
  onKeyDown: (opts: { event: KeyboardEvent }) => boolean
}

export const SuggestionList = forwardRef<SuggestionListRef, SuggestionListProps>(
  ({ items, command, label }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0)
    const listRef = useRef<HTMLDivElement>(null)

    // biome-ignore lint/correctness/useExhaustiveDependencies: items is a prop — reset selection when picker results change
    useEffect(() => {
      setSelectedIndex(0)
    }, [items])

    // Scroll selected item into view on keyboard navigation
    // biome-ignore lint/correctness/useExhaustiveDependencies: selectedIndex IS the trigger — we scroll when selection changes
    useEffect(() => {
      const list = listRef.current
      if (!list) return
      const selected = list.querySelector('[aria-selected="true"]')
      if (selected) {
        selected.scrollIntoView?.({ block: 'nearest' })
      }
    }, [selectedIndex])

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index]
        if (item) command(item)
      },
      [items, command],
    )

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        if (event.key === 'ArrowUp') {
          setSelectedIndex((prev) => (prev <= 0 ? items.length - 1 : prev - 1))
          return true
        }
        if (event.key === 'ArrowDown') {
          setSelectedIndex((prev) => (prev >= items.length - 1 ? 0 : prev + 1))
          return true
        }
        if (event.key === 'Enter') {
          selectItem(selectedIndex)
          return true
        }
        return false
      },
    }))

    if (items.length === 0) {
      return (
        <output className="suggestion-empty p-2 text-sm text-muted-foreground">No results</output>
      )
    }

    return (
      <div
        ref={listRef}
        className="suggestion-list flex flex-col gap-0.5 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
        role="listbox"
        aria-label={label ?? 'Suggestions'}
        aria-activedescendant={items[selectedIndex] ? `suggestion-${items[selectedIndex].id}` : undefined}
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            id={`suggestion-${item.id}`}
            className={cn(
              'suggestion-item flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors [@media(pointer:coarse)]:py-3 [@media(pointer:coarse)]:min-h-[44px]',
              index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
              item.isCreate && 'border-t border-border',
            )}
            onClick={() => selectItem(index)}
            onPointerEnter={() => setSelectedIndex(index)}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
          >
            {item.isCreate ? (
              <span>
                <span className="mr-1 text-muted-foreground">+</span>
                Create <strong>{item.label}</strong>
              </span>
            ) : (
              item.label
            )}
          </button>
        ))}
      </div>
    )
  },
)

SuggestionList.displayName = 'SuggestionList'
