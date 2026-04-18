/**
 * Shared suggestion popup component for # and [[ pickers.
 *
 * Rendered via ReactRenderer (outside the main React tree).
 * Keyboard navigation (ArrowUp/Down, Enter) forwarded from
 * the Suggestion plugin via the imperative ref.
 */

import { Plus } from 'lucide-react'
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { cn } from '@/lib/utils'

/** An item in the suggestion popup (tag or page). */
export interface PickerItem {
  id: string
  label: string
  /** When true, selecting this item creates a new page instead of linking to an existing one. */
  isCreate?: boolean
  /** When true, this item was matched via page alias (not direct title). */
  isAlias?: boolean
  /** Category for grouping in the slash command menu (e.g. "Tasks", "Dates"). */
  category?: string
  /** Icon component from lucide-react, rendered inline before the label. */
  icon?: React.ComponentType<{ className?: string | undefined }>
  /** Secondary breadcrumb text shown below the label (e.g. parent namespace). */
  breadcrumb?: string | undefined
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
    const { t } = useTranslation()
    const listRef = useRef<HTMLDivElement>(null)

    const selectItem = useCallback(
      (index: number) => {
        const item = items[index]
        if (item) command(item)
      },
      [items, command],
    )

    const {
      focusedIndex: selectedIndex,
      setFocusedIndex: setSelectedIndex,
      handleKeyDown,
    } = useListKeyboardNavigation({
      itemCount: items.length,
      wrap: true,
      homeEnd: true,
      pageUpDown: true,
      onSelect: selectItem,
    })

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

    useImperativeHandle(ref, () => ({
      onKeyDown: ({ event }) => {
        return handleKeyDown(event)
      },
    }))

    // Group items by category while preserving flat index for keyboard navigation.
    // Items without a category are rendered ungrouped.
    const hasCategories = items.some((item) => item.category)

    // Build ordered groups: [ { category, items: [ { item, flatIndex } ] } ]
    const groups = useMemo(() => {
      if (!hasCategories) return null
      const groupMap = new Map<string, Array<{ item: PickerItem; flatIndex: number }>>()
      const groupOrder: string[] = []
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (!item) continue
        const cat = item.category ?? ''
        if (!groupMap.has(cat)) {
          groupMap.set(cat, [])
          groupOrder.push(cat)
        }
        groupMap.get(cat)?.push({ item, flatIndex: i })
      }
      return groupOrder.map((cat) => ({ category: cat, items: groupMap.get(cat) ?? [] }))
    }, [items, hasCategories])

    if (items.length === 0) {
      return (
        <output className="suggestion-empty p-2 text-sm text-muted-foreground" aria-live="polite">
          {t('suggestion.noResults')}
        </output>
      )
    }

    const renderItemContent = (item: PickerItem) => {
      if (item.isCreate) {
        return (
          <span className="flex items-center">
            <Plus className="mr-1 h-3.5 w-3.5 text-primary" />
            {t('suggestion.create')} <strong className="ml-1">{item.label}</strong>
          </span>
        )
      }
      const Icon = item.icon
      const labelNode = item.breadcrumb ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate" title={item.label}>
            {item.label}
          </span>
          <span
            className="text-xs text-muted-foreground truncate"
            data-testid="suggestion-breadcrumb"
            title={item.breadcrumb}
          >
            {item.breadcrumb}
          </span>
        </span>
      ) : (
        item.label
      )
      if (Icon) {
        return (
          <span className={cn('flex items-center', item.breadcrumb && 'items-start')}>
            <Icon className="mr-2 mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            {labelNode}
          </span>
        )
      }
      return labelNode
    }

    const renderItem = (item: PickerItem, index: number) => (
      <button
        key={item.id}
        id={`suggestion-${item.id}`}
        className={cn(
          'suggestion-item flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors [@media(pointer:coarse)]:py-3 touch-target focus-outline',
          index === selectedIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
          item.isCreate && 'border-t border-border bg-accent/5',
        )}
        data-testid="suggestion-item"
        onClick={() => selectItem(index)}
        onPointerEnter={() => setSelectedIndex(index)}
        type="button"
        role="option"
        aria-selected={index === selectedIndex}
      >
        {renderItemContent(item)}
      </button>
    )

    return (
      <div className="suggestion-list rounded-lg border bg-popover p-1 shadow-md">
        <ScrollArea className="max-h-[min(300px,40vh)]">
          <div
            ref={listRef}
            className="flex flex-col gap-0.5"
            data-testid="suggestion-list"
            role="listbox"
            aria-label={label ?? 'Suggestions'}
            aria-activedescendant={
              items[selectedIndex] ? `suggestion-${items[selectedIndex].id}` : undefined
            }
            tabIndex={0}
          >
            {groups
              ? groups.map((group, groupIdx) => (
                  <fieldset key={group.category || '__ungrouped__'} className="border-none p-0 m-0">
                    {group.category && (
                      <>
                        {groupIdx > 0 && <hr className="border-t border-border/50 my-1" />}
                        <div
                          className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                          data-testid="suggestion-category"
                        >
                          {t(group.category)}
                        </div>
                      </>
                    )}
                    {group.items.map(({ item, flatIndex }) => renderItem(item, flatIndex))}
                  </fieldset>
                ))
              : items.map((item, index) => renderItem(item, index))}
          </div>
        </ScrollArea>
      </div>
    )
  },
)

SuggestionList.displayName = 'SuggestionList'
