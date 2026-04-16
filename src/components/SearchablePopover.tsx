/**
 * SearchablePopover — generic popover with a search input and scrollable item list.
 *
 * Extracted from SearchPanel (M-19) to eliminate duplication between
 * the page-picker and tag-picker popovers.
 */

import type React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Spinner } from '@/components/ui/spinner'

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
          <ul className="space-y-1 list-none m-0 p-0">
            {items.map((item) => (
              <li key={keyExtractor(item)}>
                <button
                  type="button"
                  className="w-full text-left px-2 py-1.5 text-sm rounded hover:bg-accent truncate"
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
