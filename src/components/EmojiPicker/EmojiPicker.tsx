/**
 * <EmojiPicker> — browse-grid emoji dialog (#286).
 *
 * A search input, a pinned Recents row, and a categorized, virtualized grid of
 * native Unicode emoji that calls `onSelect(char)` when one is chosen. This is
 * the *browse/discover* surface that complements the inline `:` typeahead
 * (#281); both read the same curated dataset (`src/editor/emoji-data.ts`) and
 * share the Recents store (`useEmojiRecents`).
 *
 * - **Search** filters by shortcode + aliases via the shared `searchEmoji`
 *   (match-sorter). An empty query shows the full categorized grid.
 * - **Recents** is a pinned MRU row (hidden when empty / while searching).
 * - **Grid** is virtualized with `@tanstack/react-virtual` so only visible
 *   rows mount — it scales to the full ~1900-emoji set. Category headers are
 *   interleaved as their own rows, and a sticky label pins the current group
 *   to the top of the scroll viewport. ARIA `grid`/`row`/`gridcell` roles;
 *   arrow-key roving focus (a single roving tabindex; Arrow keys move between
 *   cells, Home/End jump within a row, Enter/Space select); reduced-motion safe.
 * - **Skin tone** (Fitzpatrick) is a remembered preference applied to the
 *   hand/body emoji that support it.
 *
 * Rendering surface (dialog vs. mobile bottom-sheet) is the caller's concern —
 * see `EmojiPickerDialog`. This component is the picker body only.
 *
 * #2671 — the ~1900-entry dataset is lazy-loaded (`loadEmojiDataset()`) rather
 * than statically imported, so it's fetched/processed on first open of this
 * component instead of unconditionally at editor first-paint. The dataset
 * resolves virtually instantly in practice (it's a same-bundle dynamic
 * `import()`, not a network fetch — Tauri serves everything from disk), so
 * this renders a brief "Loading emoji…" placeholder rather than blocking; the
 * search box, skin-tone swatches, and Recents strip (none of which need the
 * dataset) still mount immediately.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Apple,
  Flag,
  Hand,
  Hash,
  type LucideIcon,
  Leaf,
  Lightbulb,
  Plane,
  Smile,
  Trophy,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  applySkinTone,
  computeTonableBases,
  SKIN_TONES,
  supportsSkinTone,
  type SkinToneId,
} from '@/components/EmojiPicker/emoji-skin-tone'
import { Input } from '@/components/ui/input'
import {
  type EmojiDataset,
  type EmojiEntry,
  loadEmojiDataset,
  matchEmojiQuery,
} from '@/editor/emoji-data'
import { useEmojiRecents } from '@/hooks/useEmojiRecents'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { useRovingTabindex } from '@/hooks/useRovingTabindex'
import { cn } from '@/lib/utils'

/** Stable empty set — the tonable-base set before the dataset resolves. */
const NO_TONABLE_BASES: ReadonlySet<string> = new Set()

const SKIN_TONE_KEY = 'emoji_skin_tone'
/** Emoji per grid row. A fixed column count keeps virtualization row-based. */
const COLUMNS = 8
// #2057: emoji cells grow to the 44px coarse-pointer touch floor (`size-11`),
// so the virtualizer reserves >=44px per row. `measureElement` corrects the
// real height per row after mount; this is the pre-measure estimate. On fine
// pointers the cell is 36px — overestimating the row height here is harmless
// (the spacer is re-measured), and matching the coarse case avoids a layout
// jump on touch where it matters for tap targets.
const CELL_PX = 44
const HEADER_PX = 28

type GridRow =
  | { kind: 'header'; group: string; key: string }
  | { kind: 'emoji'; entries: EmojiEntry[]; key: string }

/**
 * Icon per CLDR group for the category-jump tab strip. Keyed on the exact group
 * names the generator emits (`EMOJI_GROUPS`), so a renamed/added group surfaces
 * as a missing icon (caught by the test) rather than a silent wrong glyph.
 */
const GROUP_ICONS: Readonly<Record<string, LucideIcon>> = {
  'Smileys & Emotion': Smile,
  'People & Body': Hand,
  'Animals & Nature': Leaf,
  'Food & Drink': Apple,
  'Travel & Places': Plane,
  Activities: Trophy,
  Objects: Lightbulb,
  Symbols: Hash,
  Flags: Flag,
}

/**
 * Flatten the (optionally searched) emoji into virtualizable rows: a header
 * row per group followed by `COLUMNS`-wide emoji rows. Search results are a
 * single unlabeled section (the match order is the relevance order, so group
 * headers would only add noise).
 *
 * `dataset` is `null` before `loadEmojiDataset()` resolves (#2671) — callers
 * render the loading placeholder in that window instead of an empty grid, so
 * this returns no rows rather than guessing.
 */
function buildRows(
  query: string,
  dataset: EmojiDataset | null,
): { rows: GridRow[]; total: number } {
  const rows: GridRow[] = []
  let total = 0
  if (dataset == null) return { rows, total }
  const trimmed = query.trim()

  if (trimmed !== '') {
    const matches = matchEmojiQuery(dataset.flat, trimmed, 200)
    total = matches.length
    for (let i = 0; i < matches.length; i += COLUMNS) {
      rows.push({ kind: 'emoji', entries: matches.slice(i, i + COLUMNS), key: `s-${i}` })
    }
    return { rows, total }
  }

  for (const bucket of dataset.grouped) {
    rows.push({ kind: 'header', group: bucket.group, key: `h-${bucket.group}` })
    for (let i = 0; i < bucket.emoji.length; i += COLUMNS) {
      total += Math.min(COLUMNS, bucket.emoji.length - i)
      rows.push({
        kind: 'emoji',
        entries: bucket.emoji.slice(i, i + COLUMNS),
        key: `${bucket.group}-${i}`,
      })
    }
  }
  return { rows, total }
}

export interface EmojiPickerProps {
  /** Called with the native emoji `char` (skin tone already applied). */
  onSelect: (char: string) => void
  /** Optional class for the outer container. */
  className?: string
  /** Autofocus the search input on mount (default true). */
  autoFocusSearch?: boolean
}

export function EmojiPicker({ onSelect, className, autoFocusSearch = true }: EmojiPickerProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const { frequent, push } = useEmojiRecents()
  const [skinTone, setSkinTone] = useLocalStoragePreference<SkinToneId>(SKIN_TONE_KEY, 'default', {
    source: 'EmojiPicker',
  })

  // #2671 — the dataset lazy-loads on mount rather than shipping in the
  // editor's first-paint bundle. `loadEmojiDataset()` memoizes internally, so
  // remounting this component (e.g. reopening the dialog) after the first
  // load resolves this effect near-instantly from the cached promise.
  const [dataset, setDataset] = useState<EmojiDataset | null>(null)
  useEffect(() => {
    let cancelled = false
    loadEmojiDataset().then((d) => {
      if (!cancelled) setDataset(d)
    })
    return () => {
      cancelled = true
    }
  }, [])
  const isLoading = dataset == null
  const tonable = useMemo(
    () => (dataset == null ? NO_TONABLE_BASES : computeTonableBases(dataset.flat)),
    [dataset],
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  // #2057: roving tabindex + Arrow/Home/End for the category tablist. The
  // tablist declares role="tablist" (promising arrow-key roving) but used to
  // make every tab its own tab stop with no key handlers. Reuse the same
  // toolbar-pattern hook the rest of the app uses for 1D roving sets.
  const categoryRoving = useRovingTabindex()
  // #2545: the "Frequently used" strip used to carry orphaned role="row"/
  // role="gridcell" outside any role="grid" ancestor (aria-required-parent
  // violation) and gave each cell its own tab stop. Model it as a labelled
  // toolbar of plain buttons with a single roving tab stop, mirroring
  // SkinToneSelector and the category tablist.
  const frequentRoving = useRovingTabindex()
  const { rows, total } = useMemo(() => buildRows(query, dataset), [query, dataset])
  const isSearching = query.trim() !== ''
  const noResults = isSearching && total === 0

  // Category-jump targets: the header-row index of each group, in render order.
  // Empty while searching (groups don't apply to a flat ranked result list), so
  // the tab strip hides. Drives both the jump click and the active-tab highlight.
  const categoryTargets = useMemo(() => {
    if (isSearching) return [] as Array<{ group: string; Icon: LucideIcon; index: number }>
    const out: Array<{ group: string; Icon: LucideIcon; index: number }> = []
    rows.forEach((row, index) => {
      if (row.kind === 'header') {
        const Icon = GROUP_ICONS[row.group] ?? Smile
        out.push({ group: row.group, Icon, index })
      }
    })
    return out
  }, [rows, isSearching])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? HEADER_PX : CELL_PX),
    overscan: 4,
  })

  // The row indices that hold emoji (skipping header rows) — the spine for
  // arrow-key roving focus, which navigates between emoji cells only.
  const emojiRowIndices = useMemo(
    () => rows.flatMap((r, i) => (r.kind === 'emoji' ? [i] : [])),
    [rows],
  )
  // Roving focus position: `r` indexes into `emojiRowIndices`, `c` is the
  // column within that row. A single cell carries tabindex 0 at a time.
  const [focused, setFocused] = useState({ r: 0, c: 0 })

  // Reset scroll to the top whenever the query changes so search results
  // aren't hidden below a stale offset from the full grid.
  useEffect(() => {
    virtualizer.scrollToOffset(0)
  }, [query, virtualizer])

  // Reset roving focus to the first cell when the row set changes. Keyed on
  // `query` only — NOT `virtualizer`, whose identity isn't guaranteed stable
  // across renders (a setState here under an unstable dep would loop).
  useEffect(() => {
    setFocused({ r: 0, c: 0 })
  }, [query])

  const handleSelect = useCallback(
    (entry: EmojiEntry) => {
      const char = applySkinTone(entry.char, skinTone, tonable)
      push(char)
      onSelect(char)
    },
    [onSelect, push, skinTone, tonable],
  )

  const entriesAtRow = useCallback(
    (r: number): EmojiEntry[] => {
      const rowIndex = emojiRowIndices[r]
      const row = rowIndex === undefined ? undefined : rows[rowIndex]
      return row?.kind === 'emoji' ? [...row.entries] : []
    },
    [emojiRowIndices, rows],
  )

  // Move DOM focus to a specific cell, scrolling it into view first. Arrow
  // moves are at most one row, so the target is within the overscan window and
  // already mounted; the query is a no-op otherwise.
  const focusCell = useCallback(
    (rowIndex: number, col: number) => {
      virtualizer.scrollToIndex(rowIndex)
      scrollRef.current
        ?.querySelector<HTMLButtonElement>(`[data-cell="${rowIndex}-${col}"]`)
        ?.focus()
    },
    [virtualizer],
  )

  const handleGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const lastR = emojiRowIndices.length - 1
      if (lastR < 0) return
      let { r, c } = focused
      const len = (row: number) => entriesAtRow(row).length
      switch (e.key) {
        case 'ArrowRight': {
          if (c < len(r) - 1) c++
          else if (r < lastR) {
            r++
            c = 0
          }
          break
        }
        case 'ArrowLeft': {
          if (c > 0) c--
          else if (r > 0) {
            r--
            c = Math.max(0, len(r) - 1)
          }
          break
        }
        case 'ArrowDown': {
          if (r < lastR) {
            r++
            c = Math.min(c, len(r) - 1)
          }
          break
        }
        case 'ArrowUp': {
          if (r > 0) {
            r--
            c = Math.min(c, len(r) - 1)
          }
          break
        }
        case 'Home': {
          c = 0
          break
        }
        case 'End': {
          c = Math.max(0, len(r) - 1)
          break
        }
        default: {
          // Enter/Space activate the focused <button> natively (its onClick).
          return
        }
      }
      e.preventDefault()
      setFocused({ r, c })
      const rowIndex = emojiRowIndices[r]
      if (rowIndex !== undefined) focusCell(rowIndex, c)
    },
    [focused, emojiRowIndices, entriesAtRow, focusCell],
  )

  const showFrequent = query.trim() === '' && frequent.length > 0
  const focusedRowIndex = emojiRowIndices[focused.r]

  // Jump the grid to a group's header and pin it at the top of the viewport.
  const jumpToCategory = useCallback(
    (index: number) => {
      virtualizer.scrollToIndex(index, { align: 'start' })
    },
    [virtualizer],
  )

  // Current group pinned at the top of the scroll viewport (sticky header).
  // Derived from the first visible row's nearest preceding header; suppressed
  // while searching (search results are a single unlabeled section).
  const virtualItems = virtualizer.getVirtualItems()
  let activeGroup: string | null = null
  if (query.trim() === '') {
    const firstVisible = virtualItems[0]?.index ?? 0
    for (let i = Math.min(firstVisible, rows.length - 1); i >= 0; i--) {
      const row = rows[i]
      if (row?.kind === 'header') {
        activeGroup = row.group
        break
      }
    }
  }

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="emoji-picker">
      {/* On a narrow phone sheet the 6 skin-tone swatches crowd the search box
          (and run flush to the edge), so stack them below the full-width search
          on small widths and only sit them inline from `sm` up. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('emojiPicker.search')}
          aria-label={t('emojiPicker.search')}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional focus-on-open: the picker is an explicitly-invoked dialog and search-first is the primary interaction; mirrors SearchHeader. Caller can opt out via autoFocusSearch={false}.
          autoFocus={autoFocusSearch}
          className="flex-1"
          onKeyDown={(e) => {
            // ArrowDown from the search box drops into the grid.
            if (e.key === 'ArrowDown' && focusedRowIndex !== undefined) {
              e.preventDefault()
              focusCell(focusedRowIndex, focused.c)
            }
          }}
        />
        <SkinToneSelector value={skinTone} onChange={setSkinTone} tonable={tonable} />
      </div>

      {/* Category-jump tab strip (#286 polish). Hidden while searching (the
          flat ranked result list has no group structure). Each tab scrolls the
          grid to its group header; the active group highlights as you scroll. */}
      {categoryTargets.length > 0 && (
        <div
          ref={categoryRoving.containerRef}
          role="tablist"
          aria-label={t('emojiPicker.categories')}
          data-testid="emoji-categories"
          className="flex items-center gap-0.5 border-b pb-1"
          // Not a tab stop itself; the roving tab moves the single tabindex 0.
          tabIndex={-1}
          onKeyDown={categoryRoving.onKeyDown}
          onFocus={categoryRoving.onFocus}
        >
          {categoryTargets.map(({ group, Icon, index }) => {
            const active = group === activeGroup
            return (
              <button
                key={group}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={group}
                title={group}
                data-active={active}
                onClick={() => jumpToCategory(index)}
                className={cn(
                  'grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-ring-visible [@media(pointer:coarse)]:size-11 touch-target',
                  active && 'bg-accent text-foreground',
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
              </button>
            )
          })}
        </div>
      )}

      {showFrequent && (
        <div>
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            {t('emojiPicker.frequentlyUsed')}
          </p>
          {/* Toolbar of plain buttons (not grid row/cells): the strip sits
              OUTSIDE the role="grid" scroll container below, so row/gridcell
              here would be orphaned (axe aria-required-parent). A single roving
              tab stop + Arrow/Home/End matches SkinToneSelector + the tablist. */}
          <div
            ref={frequentRoving.containerRef}
            role="toolbar"
            aria-label={t('emojiPicker.frequentlyUsedRow')}
            className="flex flex-wrap gap-0.5"
            // Not a tab stop itself; the roving tab moves the single tabindex 0.
            tabIndex={-1}
            onKeyDown={frequentRoving.onKeyDown}
            onFocus={frequentRoving.onFocus}
          >
            {frequent.slice(0, COLUMNS).map((char) => (
              <button
                key={`frequent-${char}`}
                type="button"
                aria-label={char}
                title={char}
                onClick={() => {
                  push(char)
                  onSelect(char)
                }}
                className="grid size-9 place-items-center rounded-md text-xl leading-none hover:bg-accent focus-ring-visible [@media(pointer:coarse)]:size-11 touch-target"
              >
                {char}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="relative">
        {activeGroup !== null && (
          <div
            // Decorative: the inline header rows carry the real group semantics;
            // this is a visual pin only (hence aria-hidden), so screen readers
            // don't hear the group name twice.
            aria-hidden="true"
            data-testid="emoji-sticky-group"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-popover/95 px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground"
          >
            {activeGroup}
          </div>
        )}
        <div
          ref={scrollRef}
          role="grid"
          aria-label={t('emojiPicker.grid')}
          className="h-64 overflow-y-auto"
          data-testid="emoji-grid"
          // Programmatically focusable (not a tab stop) so the grid can host
          // the arrow-key handler; the roving cell keeps the single tabindex 0.
          tabIndex={-1}
          onKeyDown={handleGridKeyDown}
        >
          {isLoading && (
            <p
              data-testid="emoji-loading"
              className="px-3 py-10 text-center text-sm text-muted-foreground"
            >
              {t('emojiPicker.loading')}
            </p>
          )}
          {!isLoading && noResults && (
            <p
              data-testid="emoji-no-results"
              className="px-3 py-10 text-center text-sm text-muted-foreground"
            >
              {t('emojiPicker.noResults', { query: query.trim() })}
            </p>
          )}
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
            {virtualItems.map((vi) => {
              const row = rows[vi.index]
              if (row === undefined) return null
              return (
                <div
                  key={row.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  {row.kind === 'header' ? (
                    <p className="px-1 pt-2 text-xs font-medium text-muted-foreground">
                      {row.group}
                    </p>
                  ) : (
                    /* oxlint-disable jsx-a11y/prefer-tag-over-role -- ARIA grid row + gridcells inside a virtualized absolutely-positioned grid; <table>/<tr>/<td> cannot host the transform-positioned rows the virtualizer requires (mirrors MonthlyView) */
                    <div role="row" className="flex gap-0.5">
                      {row.entries.map((entry, col) => {
                        const char = applySkinTone(entry.char, skinTone, tonable)
                        const isFocused = vi.index === focusedRowIndex && col === focused.c
                        return (
                          <button
                            key={entry.name}
                            type="button"
                            role="gridcell"
                            data-cell={`${vi.index}-${col}`}
                            aria-label={entry.name}
                            title={`:${entry.name}:`}
                            tabIndex={isFocused ? 0 : -1}
                            onClick={() => handleSelect(entry)}
                            className="grid size-9 place-items-center rounded-md text-xl leading-none hover:bg-accent focus-ring-visible [@media(pointer:coarse)]:size-11 touch-target"
                          >
                            {char}
                          </button>
                        )
                      })}
                    </div>
                    /* oxlint-enable jsx-a11y/prefer-tag-over-role */
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

interface SkinToneSelectorProps {
  value: SkinToneId
  onChange: (tone: SkinToneId) => void
  /**
   * Tonable-base set (#2671 — derived from the lazily-loaded dataset). Empty
   * (all swatches render the untoned sample) until `<EmojiPicker>`'s dataset
   * load resolves.
   */
  tonable: ReadonlySet<string>
}

/**
 * Compact skin-tone picker: a row of six swatches (default + five Fitzpatrick
 * tones) applied to a sample thumbs-up. Implemented as a `radiogroup` for
 * keyboard + screen-reader parity.
 */
function SkinToneSelector({ value, onChange, tonable }: SkinToneSelectorProps) {
  const { t } = useTranslation()
  const sample = '\u{1F44D}' // thumbsup — supports skin tone
  // #2057: roving tabindex + Arrow/Home/End for the radiogroup. The container
  // declared role="radiogroup" but every swatch was its own tab stop with no
  // key handlers; reuse the shared toolbar-pattern hook (same as the category
  // tablist) so Tab lands once and arrows move between swatches.
  const roving = useRovingTabindex()
  return (
    <div
      ref={roving.containerRef}
      role="radiogroup"
      aria-label={t('emojiPicker.skinTone')}
      className="flex items-center gap-0.5"
      // Not a tab stop itself; the roving tab moves the single tabindex 0.
      tabIndex={-1}
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      {SKIN_TONES.map((tone) => {
        const label = t(tone.labelKey)
        return (
          /* oxlint-disable jsx-a11y/prefer-tag-over-role -- role="radio" on a styled emoji <button>; a native <input type="radio"> would lose the swatch styling and aria-checked toggle behavior (mirrors IncludeExcludeToggle / QueryBuilderModal) */
          <button
            key={tone.id}
            type="button"
            role="radio"
            aria-checked={value === tone.id}
            aria-label={label}
            title={label}
            onClick={() => onChange(tone.id)}
            className={cn(
              'grid size-7 place-items-center rounded-md text-base leading-none hover:bg-accent focus-ring-visible [@media(pointer:coarse)]:size-11 touch-target',
              value === tone.id && 'bg-accent ring-1 ring-ring',
            )}
          >
            {tone.id === 'default' || !supportsSkinTone(sample, tonable)
              ? sample
              : applySkinTone(sample, tone.id, tonable)}
          </button>
          /* oxlint-enable jsx-a11y/prefer-tag-over-role */
        )
      })}
    </div>
  )
}
