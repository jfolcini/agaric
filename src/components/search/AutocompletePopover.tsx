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

import { useCommandState } from 'cmdk'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef } from 'react'

import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

export interface AutocompleteItem {
  /** The string inserted into the input when this item is picked. */
  value: string
  /** Display label (defaults to `value`). */
  label?: string
}

/** Real DOM ids of the rendered listbox + currently-highlighted option,
 *  used by the owning input for `aria-controls` / `aria-activedescendant`.
 *  cmdk generates these ids internally via `useId()` and ignores any
 *  caller-supplied `id` props, so the only correct way to wire ARIA
 *  combobox-with-listbox is to read them from the live DOM. */
export interface AutocompleteAriaIds {
  listboxId: string
  activeDescendantId: string | null
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
  /** Fires after each render with the live cmdk-generated listbox id
   *  and active-option id. Caller forwards these to the owning input's
   *  `aria-controls` / `aria-activedescendant`. `null` on unmount. */
  onAriaIdsChange?: (ids: AutocompleteAriaIds | null) => void
}

type Measurable = { getBoundingClientRect: () => DOMRect }

/**
 * Bridge inside `<Command>` that subscribes to cmdk's internal store
 * via `useCommandState`. cmdk batches `selectedItemId` updates one
 * tick after the `value` prop changes, so an outer effect on the
 * parent props races the DOM. Re-running `onSync` whenever cmdk's
 * own `selectedItemId` changes keeps `aria-activedescendant` pinned
 * to the live DOM id.
 */
function SelectedItemBridge({ onSync }: { onSync: () => void }): null {
  const selectedItemId = useCommandState((s) => s.selectedItemId as string | undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: `selectedItemId` is the trigger, not body-read — we re-sync ids when cmdk moves the highlight.
  useEffect(() => {
    onSync()
  }, [selectedItemId])
  return null
}

export function AutocompletePopover({
  open,
  anchorRect,
  items,
  selectedValue,
  onSelectedValueChange,
  onSelect,
  label,
  onAriaIdsChange,
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

  // Track the popover content node so we can read cmdk's generated ids
  // post-render (cmdk owns its listbox / option ids via `useId()` and
  // overrides any `id` prop we pass; querying the live DOM is the only
  // way to wire ARIA correctly).
  const contentRef = useRef<HTMLDivElement | null>(null)
  // Memoised key of the last-emitted ids so the per-render sync effect
  // doesn't fire `setState` in a render loop when ids are unchanged.
  const lastEmittedKeyRef = useRef<string | null>(null)
  const syncAriaIds = useCallback(() => {
    if (onAriaIdsChange == null) return
    const root = contentRef.current
    const listbox = root?.querySelector('[role="listbox"]')
    if (listbox == null || listbox.id === '') {
      if (lastEmittedKeyRef.current !== null) {
        lastEmittedKeyRef.current = null
        onAriaIdsChange(null)
      }
      return
    }
    const active = listbox.querySelector('[role="option"][aria-selected="true"]')
    const activeId = active?.id ?? null
    const key = `${listbox.id}|${activeId ?? ''}`
    if (lastEmittedKeyRef.current === key) return
    lastEmittedKeyRef.current = key
    onAriaIdsChange({ listboxId: listbox.id, activeDescendantId: activeId })
  }, [onAriaIdsChange])
  // Run after every commit so the ids reflect the freshly-rendered DOM.
  useEffect(() => {
    syncAriaIds()
  })
  // Emit null on unmount so the owning input drops aria-controls.
  useEffect(
    () => () => {
      onAriaIdsChange?.(null)
    },
    [onAriaIdsChange],
  )

  if (!open || anchorRect == null || items.length === 0) {
    return null
  }

  return (
    <Popover open modal={false}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        ref={contentRef}
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
          <SelectedItemBridge onSync={syncAriaIds} />
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
