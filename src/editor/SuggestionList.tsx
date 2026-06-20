/**
 * Shared suggestion popup component for # and [[ pickers.
 *
 * Rendered via ReactRenderer (outside the main React tree).
 * Keyboard navigation (ArrowUp/Down, Enter) forwarded from
 * the Suggestion plugin via the imperative ref.
 */

import { Plus } from 'lucide-react'
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { Kbd } from '@/components/ui/kbd'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import { formatChordTokens } from '@/lib/keyboard-config/format-chord'
import { getShortcutKeys } from '@/lib/keyboard-config/storage'
import { cn } from '@/lib/utils'

/** An item in the suggestion popup (tag or page). */
export interface PickerItem {
  id: string
  label: string
  /** When true, selecting this item creates a new page instead of linking to an existing one. */
  isCreate?: boolean
  /**
   * When true, this item was matched via a page alias (not direct
   * title). Used for visual differentiation only — exact-vs-prefix
   * Disambiguation lives on `aliasText`.
   */
  isAlias?: boolean
  /**
   * The actual alias text that matched (e.g. "pp"). Set on every
   * alias-source result, exact and prefix alike. Used by the
   * `[[text]]` input rule to tell whether the typed text is exactly
   * an alias and should auto-resolve, vs. a prefix that should not
   *.
   */
  aliasText?: string
  /** Category for grouping in the slash command menu (e.g. "Tasks", "Dates"). */
  category?: string
  /** Icon component from lucide-react, rendered inline before the label. */
  icon?: React.ComponentType<{ className?: string | undefined }>
  /**
   * Native emoji glyph rendered inline before the label (#130 — the `:`
   * emoji picker). Mutually exclusive with `icon`; when set, the row shows
   * the emoji then its `:shortcode` label.
   */
  emoji?: string
  /** Secondary breadcrumb text shown below the label (e.g. parent namespace). */
  breadcrumb?: string | undefined
  /**
   * Keyboard catalog id whose *live* binding is rendered as a right-aligned
   * chord chip (picks up user rebinds via `getShortcutKeys`). Use for items
   * backed by the keyboard catalog — e.g. the `/strike` mark → `strikethrough`.
   * Takes precedence over `keys` when both are set. #211 P0-5.
   */
  shortcutId?: string
  /**
   * Static chord string (e.g. "Ctrl + B") rendered as a right-aligned chip
   * for items with no keyboard-catalog entry — e.g. `/bold` and `/italic`,
   * which use TipTap StarterKit defaults. Ignored when `shortcutId` is set.
   */
  keys?: string
}

export interface SuggestionListProps {
  items: PickerItem[]
  command: (item: PickerItem) => void
  /** Accessible label for the suggestion listbox (e.g. "Tags", "Block links"). */
  label?: string
  /**
   * Trigger character that opened this picker (e.g. '@', '[[', '((', '/', '::').
   * Used to pick a context-appropriate empty-state message.
   */
  triggerChar?: string
  /**
   * The live query text. Used to distinguish a below-threshold empty result
   * (block-ref search needs ≥2 chars — #213 PR 2) from a genuine "no match",
   * so the empty-state can say *why* nothing is shown.
   */
  query?: string
  /**
   * Stable DOM id for the listbox container (#1102). The combobox
   * contenteditable points its `aria-controls` here, so it must be a known,
   * stable value rather than an auto-generated one.
   */
  listboxId?: string
  /**
   * Reports the currently-highlighted option's id (`suggestion-<id>`), or
   * `null` when there is no active option (#1102). The suggestion renderer
   * uses this to keep `aria-activedescendant` in sync on the FOCUSED
   * contenteditable (the listbox itself never holds focus), implementing the
   * WCAG editable-combobox pattern.
   */
  onActiveDescendantChange?: (id: string | null) => void
  ref?: React.Ref<SuggestionListRef>
}

/**
 * Default stable id for the suggestion listbox container (#1102). Only one
 * picker is open at a time (a single `.suggestion-popup` in the DOM), so a
 * constant id is unambiguous and gives `aria-controls` a fixed target.
 */
export const SUGGESTION_LISTBOX_ID = 'suggestion-listbox'

export interface SuggestionListRef {
  onKeyDown: (opts: { event: KeyboardEvent }) => boolean
}

export const SuggestionList = ({
  ref,
  items,
  command,
  label,
  triggerChar,
  query,
  listboxId = SUGGESTION_LISTBOX_ID,
  onActiveDescendantChange,
}: SuggestionListProps) => {
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

  // #1102 — the id of the currently-highlighted option, or null when there is
  // no active row (empty list). This is the source of truth fed to the FOCUSED
  // contenteditable's `aria-activedescendant` (the listbox stays unfocused).
  const activeItem = items[selectedIndex]
  const activeDescendantId = activeItem ? `suggestion-${activeItem.id}` : null

  // Scroll selected item into view on keyboard navigation
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const selected = list.querySelector('[aria-selected="true"]')
    if (selected) {
      selected.scrollIntoView?.({ block: 'nearest' })
    }
  }, [selectedIndex])

  // #1102 — report the active option id to the renderer so it can mirror it as
  // `aria-activedescendant` on the contenteditable that actually holds focus.
  // Fires on every highlight move (arrow nav) and on every results change.
  useEffect(() => {
    onActiveDescendantChange?.(activeDescendantId)
  }, [activeDescendantId, onActiveDescendantChange])

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => handleKeyDown(event),
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
    // #213 PR 2 — the block-ref search ('((') returns [] for queries under
    // 2 chars (useBlockResolve `searchBlockRefs`), which reads as "broken"
    // rather than "keep typing". Distinguish that below-threshold case from
    // a genuine no-match and tell the user to keep going. Mirror the
    // resolver's normalisation (strip trailing ')' + trim).
    const blockRefBelowThreshold =
      triggerChar === '((' && query != null && query.replace(/\)+$/, '').trim().length < 2
    // Pick a context-appropriate empty-state message based on the
    // trigger character. Falls back to the generic "No results" for triggers
    // without a tailored copy (e.g. '/', '::').
    const emptyKey = blockRefBelowThreshold
      ? 'suggestion.hint.minChars'
      : triggerChar === '[['
        ? 'suggestion.noResults.blockLink'
        : triggerChar === '@'
          ? 'suggestion.noResults.atTag'
          : triggerChar === '(('
            ? 'suggestion.noResults.blockRef'
            : triggerChar === ':'
              ? 'suggestion.noResults.emoji'
              : 'suggestion.noResults'
    return (
      // #216 C1 — name the live region so AT announces it in context
      // ("Tags: No results") rather than a bare, origin-less message. Mirrors
      // the listbox's `aria-label` below.
      <output
        className="suggestion-empty p-2 text-sm text-muted-foreground"
        aria-live="polite"
        aria-label={label ?? 'Suggestions'}
      >
        {t(emptyKey)}
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
    if (item.emoji) {
      // #130 — the `:` emoji picker. Show the native glyph then its
      // `:shortcode` so the binding is reinforced as the user scans.
      return (
        <span className="flex items-center">
          <span className="mr-2 text-base leading-none" aria-hidden="true">
            {item.emoji}
          </span>
          <span className="truncate" title={item.label}>
            :{item.label}
          </span>
        </span>
      )
    }
    if (Icon) {
      return (
        <span className={cn('flex items-center', item.breadcrumb && 'items-start')}>
          <Icon className="mr-2 mt-0.5 h-4 w-4 shrink-0 text-muted-foreground [@media(pointer:coarse)]:h-[18px] [@media(pointer:coarse)]:w-[18px]" />
          {labelNode}
        </span>
      )
    }
    return labelNode
  }

  // Right-aligned chord chips for a row's keyboard shortcut. Prefers the live
  // catalog binding (`shortcutId`, picks up rebinds); falls back to a static
  // `keys` string for marks with no catalog entry (Bold/Italic). Returns null
  // when neither is set so non-mark rows keep their existing layout. #211 P0-5.
  const renderShortcut = (item: PickerItem) => {
    const keys = item.shortcutId ? getShortcutKeys(item.shortcutId) : (item.keys ?? '')
    const tokens = formatChordTokens(keys)
    if (tokens.length === 0) return null
    return (
      <span
        className="ml-auto inline-flex items-center gap-1 pl-2"
        aria-hidden="true"
        data-testid={`suggestion-shortcut-${item.id}`}
      >
        {tokens.map((tok) => (
          // #1004 — the canonical <Kbd> carries its own bg/fg so the chip
          // stays legible on a selected (`bg-accent`) row.
          <Kbd key={tok}>{tok}</Kbd>
        ))}
      </span>
    )
  }

  const renderItem = (item: PickerItem, index: number) => (
    <button
      key={item.id}
      id={`suggestion-${item.id}`}
      className={cn(
        'suggestion-item flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm transition-colors [@media(pointer:coarse)]:py-3 [@media(pointer:coarse)]:min-h-[44px] touch-target focus-outline',
        index === selectedIndex
          ? 'bg-accent text-accent-foreground'
          : 'hover:bg-accent hover:text-accent-foreground',
        item.isCreate && 'border-t border-border/50',
      )}
      data-testid="suggestion-item"
      onClick={() => selectItem(index)}
      // #924 — preventDefault on pointerdown so focus never leaves the editor
      // when an item is clicked (belt-and-suspenders with the portal blur-guard,
      // matching the bubble-menu mark buttons).
      onPointerDown={(e) => e.preventDefault()}
      onPointerEnter={() => setSelectedIndex(index)}
      type="button"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="option" on the clickable suggestion <button>; native <option> can't host the rich item content + click/pointer handlers
      role="option"
      aria-selected={index === selectedIndex}
    >
      {renderItemContent(item)}
      {renderShortcut(item)}
    </button>
  )

  return (
    <div
      className="suggestion-list rounded-lg border bg-popover p-1 shadow-(--shadow-floating)"
      data-editor-portal
    >
      {/* #1102 — live result-count status. Announced on EVERY update (the
          previous `aria-live` lived only in the empty branch), so AT users hear
          how many suggestions are available as they type. Visually hidden;
          purely an announcement channel for the editable-combobox pattern. */}
      <output className="sr-only" aria-live="polite" data-testid="suggestion-status">
        {t('suggestion.results.count', { count: items.length })}
      </output>
      <ScrollArea className="max-h-[min(300px,40vh)]">
        <div
          ref={listRef}
          // #1102 — stable id so the combobox contenteditable's `aria-controls`
          // (set by the suggestion renderer on `editor.view.dom`) has a target.
          id={listboxId}
          // #1009 — scale the whole list up on coarse pointers so the label,
          // breadcrumb and kbd chip grow in lockstep with the `py-3` rows
          // (the footer keeps its own `text-xs` outside this container).
          className="flex flex-col gap-0.5 [@media(pointer:coarse)]:text-base"
          data-testid="suggestion-list"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom editor-suggestion listbox driven by aria-activedescendant; <datalist>/<select> can't host the grouped clickable <button> options
          role="listbox"
          aria-label={label ?? 'Suggestions'}
          // #1102 — the editable-combobox source of truth for the active option
          // lives on the FOCUSED contenteditable (driven by the renderer via
          // `onActiveDescendantChange`); the unfocused listbox mirrors it so the
          // relationship is also expressed structurally for AT that inspects it.
          aria-activedescendant={activeDescendantId ?? undefined}
          tabIndex={0}
        >
          {groups
            ? groups.map((group, groupIdx) => (
                <fieldset key={group.category || '__ungrouped__'} className="border-none p-0 m-0">
                  {group.category && (
                    <>
                      {groupIdx > 0 && <hr className="border-t border-border/50 my-1" />}
                      <h3
                        className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground uppercase tracking-wider"
                        data-testid="suggestion-category"
                      >
                        {t(group.category)}
                      </h3>
                    </>
                  )}
                  {group.items.map(({ item, flatIndex }) => renderItem(item, flatIndex))}
                </fieldset>
              ))
            : items.map((item, index) => renderItem(item, index))}
        </div>
      </ScrollArea>
      {/* #1006 — the footer is pointer-conditional, not width-conditional: a
          large tablet is still touch. Fine pointers keep the keyboard hints
          (↑↓ / ↵⇥ / Esc — meaningless on touch); coarse pointers get touch
          copy. Both share identical chrome (`px-2 py-1 text-xs … border-t`);
          only the text differs. The strip is non-interactive, so no touch
          target padding. Decorative → `aria-hidden`. */}
      <div
        className="border-t border-border/50 px-2 py-1 text-xs text-muted-foreground select-none hidden items-center gap-2 [@media(pointer:fine)]:flex"
        data-testid="suggestion-list-footer"
        aria-hidden="true"
      >
        <span>{t('suggestion.footer.navigate')}</span>
        <span className="text-border">·</span>
        <span>{t('suggestion.footer.select')}</span>
        <span className="text-border">·</span>
        <span>{t('suggestion.footer.close')}</span>
      </div>
      <div
        className="border-t border-border/50 px-2 py-1 text-xs text-muted-foreground select-none hidden items-center gap-2 [@media(pointer:coarse)]:flex"
        data-testid="suggestion-list-footer-touch"
        aria-hidden="true"
      >
        <span>{t('suggestion.footer.touch.select')}</span>
      </div>
    </div>
  )
}

SuggestionList.displayName = 'SuggestionList'
