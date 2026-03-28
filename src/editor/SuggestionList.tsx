/**
 * Shared suggestion popup component for # and [[ pickers.
 *
 * Rendered via ReactRenderer (outside the main React tree).
 * Keyboard navigation (ArrowUp/Down, Enter) forwarded from
 * the Suggestion plugin via the imperative ref.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from 'react'
import { cn } from '@/lib/utils'

/** An item in the suggestion popup (tag or page). */
export interface PickerItem {
  id: string
  label: string
}

export interface SuggestionListProps {
  items: PickerItem[]
  command: (item: PickerItem) => void
}

export interface SuggestionListRef {
  onKeyDown: (opts: { event: KeyboardEvent }) => boolean
}

export const SuggestionList = forwardRef<SuggestionListRef, SuggestionListProps>(
  ({ items, command }, ref) => {
    const [selectedIndex, setSelectedIndex] = useState(0)

    // biome-ignore lint/correctness/useExhaustiveDependencies: items is a prop — reset selection when picker results change
    useEffect(() => {
      setSelectedIndex(0)
    }, [items])

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
      return <div className="suggestion-empty p-2 text-sm text-muted-foreground">No results</div>
    }

    return (
      <div
        className="suggestion-list flex flex-col gap-0.5 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
        role="listbox"
      >
        {items.map((item, index) => (
          <button
            key={item.id}
            className={cn(
              'suggestion-item flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
            )}
            onClick={() => selectItem(index)}
            onMouseEnter={() => setSelectedIndex(index)}
            type="button"
            role="option"
            aria-selected={index === selectedIndex}
          >
            {item.label}
          </button>
        ))}
      </div>
    )
  },
)

SuggestionList.displayName = 'SuggestionList'
