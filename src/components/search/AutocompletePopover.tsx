/**
 * PEND-60 Phase 1 — Caret-anchored autocomplete popover.
 *
 * Renders a Radix Popover anchored at a caller-supplied `DOMRect`
 * (the caret pixel position) containing a cmdk-based list of value
 * suggestions. The parent component (SearchPanel) drives keyboard
 * input — this component is "headless" with respect to keyboard
 * navigation; the highlighted item is controlled via `selectedValue`.
 *
 * The popover is non-modal and prevents Radix's open/close
 * auto-focus so the search input keeps focus while the user types.
 */

import type React from 'react'
import { useMemo, useRef } from 'react'

import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

export interface AutocompleteItem {
  /** The string inserted into the input when this item is picked. */
  value: string
  /** Display label (defaults to `value`). */
  label?: string
}

export interface AutocompletePopoverProps {
  /** Controls Radix Popover open state. */
  open: boolean
  /** Caret-pixel anchor rect. When null, the popover renders nothing
   *  even if `open` is true (defensive — caller should not pass open
   *  with a null rect, but guard anyway). */
  anchorRect: DOMRect | null
  /** Items to render. Pre-filtered by the parent. */
  items: ReadonlyArray<AutocompleteItem>
  /** Currently-highlighted item value (controlled). When null, no
   *  item is highlighted. */
  selectedValue: string | null
  /** Fires when cmdk's internal selection changes (e.g. mouse hover
   *  over an item, or the parent driving arrow keys). */
  onSelectedValueChange: (value: string) => void
  /** Fires when the user picks an item via click (keyboard Enter is
   *  intercepted upstream by the parent). */
  onSelect: (value: string) => void
  /** ARIA label for the listbox. */
  label: string
}

type Measurable = { getBoundingClientRect: () => DOMRect }

export function AutocompletePopover({
  open,
  anchorRect,
  items,
  selectedValue,
  onSelectedValueChange,
  onSelect,
  label,
}: AutocompletePopoverProps): React.ReactElement | null {
  // virtualRef must remain stable across renders; only its `current`
  // closure changes when anchorRect updates. Radix Popper reads
  // `getBoundingClientRect` on each layout measurement.
  const virtualRef = useRef<Measurable>({
    getBoundingClientRect: () => anchorRect ?? new DOMRect(),
  })
  virtualRef.current = useMemo<Measurable>(
    () => ({
      getBoundingClientRect: () => anchorRect ?? new DOMRect(),
    }),
    [anchorRect],
  )

  if (!open || anchorRect == null || items.length === 0) {
    return null
  }

  return (
    <Popover open modal={false}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        // preventDefault on both autofocus events keeps focus in the
        // search input — without it, Radix's FocusScope would steal it.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="p-0 w-64"
        aria-label={label}
        data-testid="autocomplete-popover"
      >
        <Command
          shouldFilter={false}
          {...(selectedValue != null ? { value: selectedValue } : {})}
          onValueChange={onSelectedValueChange}
        >
          <CommandList label={label}>
            {items.map((item) => (
              <CommandItem
                key={item.value}
                value={item.value}
                onSelect={() => onSelect(item.value)}
                data-testid={`autocomplete-item-${item.value}`}
              >
                {item.label ?? item.value}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
