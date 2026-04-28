/**
 * SearchablePopover — generic popover with a search input and scrollable item list.
 *
 * Extracted from SearchPanel (M-19) to eliminate duplication between
 * the page-picker and tag-picker popovers.
 *
 * UX-9: arrow-key navigation across the list is provided by the shared
 * `useListKeyboardNavigation` hook. ArrowUp / ArrowDown move the
 * roving-tabindex focus across the rows; Enter (or Space) on the
 * focused row triggers `onSelect`. The hook is in vertical mode with
 * wrap enabled so navigation is symmetric at both ends. The visual
 * focus-visible ring is preserved — the hook only adds keyboard
 * traversal, not new styling.
 */

import type React from 'react'
import { useEffect, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'

export interface SearchablePopoverProps<T> {
  /** Whether the popover is open. */
  open: boolean
  /** Callback when the popover open state changes. */
  onOpenChange: (open: boolean) => void

  /** Items to display in the list. */
  items: T[]
  /** Whether items are currently loading. */
  isLoading: boolean

  /** Callback when an item is selected. */
  onSelect: (item: T) => void
  /** Render function for each item's display content. */
  renderItem: (item: T) => React.ReactNode
  /** Extract a unique key for each item. */
  keyExtractor: (item: T) => string

  /** Current search input value. */
  searchValue: string
  /** Callback when the search input changes. */
  onSearchChange: (value: string) => void
  /** Placeholder text for the search input. */
  searchPlaceholder: string
  /** Message shown when there are no items and not loading. */
  emptyMessage: string

  /** Label for the trigger button. */
  triggerLabel: string
  /** Whether the trigger button is disabled. */
  triggerDisabled?: boolean
  /** Optional predicate to disable individual items. */
  isItemDisabled?: (item: T) => boolean
}

export function SearchablePopover<T>({
  open,
  onOpenChange,
  items,
  isLoading,
  onSelect,
  renderItem,
  keyExtractor,
  searchValue,
  onSearchChange,
  searchPlaceholder,
  emptyMessage,
  triggerLabel,
  triggerDisabled = false,
  isItemDisabled,
}: SearchablePopoverProps<T>): React.ReactElement {
  // UX-9: arrow-key list navigation. The hook owns `focusedIndex` and
  // `handleKeyDown`; we wire the former into a roving `tabIndex` and the
  // latter onto the list container. `onSelect` short-circuits if the
  // focused item is disabled — we don't want Enter to fire a no-op.
  const { focusedIndex, handleKeyDown } = useListKeyboardNavigation({
    itemCount: items.length,
    onSelect: (index) => {
      const item = items[index]
      if (item == null) return
      if (isItemDisabled?.(item)) return
      onSelect(item)
    },
  })

  // Track per-row buttons so we can move DOM focus to the row the hook
  // just focused. Without this the visible focus ring wouldn't follow
  // the keyboard, and screen readers wouldn't announce the new row.
  const buttonRefs = useRef(new Map<number, HTMLButtonElement | null>())

  useEffect(() => {
    // Only steal focus when the user is already navigating inside the
    // list — otherwise opening the popover would yank focus off the
    // search input on every itemCount change.
    const activeEl = document.activeElement
    const isInsideList = Array.from(buttonRefs.current.values()).some((btn) => btn === activeEl)
    if (!isInsideList) return
    const target = buttonRefs.current.get(focusedIndex)
    if (target != null) target.focus()
  }, [focusedIndex])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={triggerDisabled}>
          {triggerLabel}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 max-w-[calc(100vw-2rem)] p-2" align="start">
        <Input
          value={searchValue}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="mb-2"
          autoFocus
        />
        {isLoading && <Spinner className="mx-auto my-2 text-muted-foreground" />}
        {!isLoading && items.length === 0 && (
          <p className="text-xs text-muted-foreground p-2">{emptyMessage}</p>
        )}
        <ScrollArea className="max-h-48">
          <ul
            className="space-y-1 list-none m-0 p-0"
            onKeyDown={(e) => {
              // The hook returns `true` when the key was consumed (arrow
              // keys, Enter, Space). preventDefault stops the page from
              // scrolling on arrow keys and from triggering form submits
              // on Enter.
              if (handleKeyDown(e)) e.preventDefault()
            }}
          >
            {items.map((item, idx) => (
              <li key={keyExtractor(item)}>
                <button
                  ref={(el) => {
                    if (el != null) buttonRefs.current.set(idx, el)
                    else buttonRefs.current.delete(idx)
                  }}
                  type="button"
                  tabIndex={idx === focusedIndex ? 0 : -1}
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent truncate focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-hidden"
                  onClick={() => onSelect(item)}
                  disabled={isItemDisabled?.(item)}
                >
                  {renderItem(item)}
                </button>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
