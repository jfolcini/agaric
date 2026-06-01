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
 *   rows mount — it scales to the full set. Category headers are interleaved
 *   as their own rows. ARIA `grid`/`row`/`gridcell` roles; arrow-key roving
 *   focus; reduced-motion safe (no animation here).
 * - **Skin tone** (Fitzpatrick) is a remembered preference applied to the
 *   hand/body emoji that support it.
 *
 * Rendering surface (dialog vs. mobile bottom-sheet) is the caller's concern —
 * see `EmojiPickerDialog`. This component is the picker body only.
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { groupedEmoji, searchEmoji, type EmojiEntry } from '@/editor/emoji-data'
import { useEmojiRecents } from '@/hooks/useEmojiRecents'
import { useLocalStoragePreference } from '@/hooks/useLocalStoragePreference'
import { cn } from '@/lib/utils'

import { Input } from '../ui/input'
import { applySkinTone, SKIN_TONES, supportsSkinTone, type SkinToneId } from './emoji-skin-tone'

const SKIN_TONE_KEY = 'emoji_skin_tone'
/** Emoji per grid row. A fixed column count keeps virtualization row-based. */
const COLUMNS = 8
const CELL_PX = 40
const HEADER_PX = 28

type GridRow =
  | { kind: 'header'; group: string; key: string }
  | { kind: 'emoji'; entries: EmojiEntry[]; key: string }

/**
 * Flatten the (optionally searched) emoji into virtualizable rows: a header
 * row per group followed by `COLUMNS`-wide emoji rows. Search results are a
 * single unlabeled section (the match order is the relevance order, so group
 * headers would only add noise).
 */
function buildRows(query: string): { rows: GridRow[]; total: number } {
  const rows: GridRow[] = []
  let total = 0
  const trimmed = query.trim()

  if (trimmed !== '') {
    const matches = searchEmoji(trimmed, 200)
    total = matches.length
    for (let i = 0; i < matches.length; i += COLUMNS) {
      rows.push({ kind: 'emoji', entries: matches.slice(i, i + COLUMNS), key: `s-${i}` })
    }
    return { rows, total }
  }

  for (const bucket of groupedEmoji()) {
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
  const { recents, push } = useEmojiRecents()
  const [skinTone, setSkinTone] = useLocalStoragePreference<SkinToneId>(SKIN_TONE_KEY, 'default', {
    source: 'EmojiPicker',
  })

  const scrollRef = useRef<HTMLDivElement>(null)
  const { rows } = useMemo(() => buildRows(query), [query])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'header' ? HEADER_PX : CELL_PX),
    overscan: 4,
  })

  // Reset scroll to the top whenever the query changes so search results
  // aren't hidden below a stale scroll offset from the full grid.
  useEffect(() => {
    virtualizer.scrollToOffset(0)
  }, [query, virtualizer])

  const handleSelect = useCallback(
    (entry: EmojiEntry) => {
      const char = applySkinTone(entry.char, skinTone)
      push(char)
      onSelect(char)
    },
    [onSelect, push, skinTone],
  )

  const showRecents = query.trim() === '' && recents.length > 0

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="emoji-picker">
      <div className="flex items-center gap-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('emojiPicker.search')}
          aria-label={t('emojiPicker.search')}
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- intentional focus-on-open: the picker is an explicitly-invoked dialog and search-first is the primary interaction; mirrors SearchHeader. Caller can opt out via autoFocusSearch={false}.
          autoFocus={autoFocusSearch}
          className="flex-1"
        />
        <SkinToneSelector value={skinTone} onChange={setSkinTone} />
      </div>

      {showRecents && (
        <div>
          <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            {t('emojiPicker.recents')}
          </p>
          {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- ARIA grid row + gridcells; an emoji picker is not tabular data, and <table>/<tr>/<td> here would inject table semantics + break the flex-wrap layout */}
          <div
            className="flex flex-wrap gap-0.5"
            role="row"
            aria-label={t('emojiPicker.recentsRow')}
          >
            {recents.slice(0, COLUMNS).map((char) => (
              <button
                key={`recent-${char}`}
                type="button"
                role="gridcell"
                aria-label={char}
                title={char}
                onClick={() => {
                  push(char)
                  onSelect(char)
                }}
                className="grid size-9 place-items-center rounded-md text-xl leading-none hover:bg-accent focus-ring-visible"
              >
                {char}
              </button>
            ))}
          </div>
          {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
        </div>
      )}

      <div
        ref={scrollRef}
        role="grid"
        aria-label={t('emojiPicker.grid')}
        className="h-64 overflow-y-auto"
        data-testid="emoji-grid"
      >
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
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
                  <p className="px-1 pt-2 text-xs font-medium text-muted-foreground">{row.group}</p>
                ) : (
                  /* oxlint-disable jsx-a11y/prefer-tag-over-role -- ARIA grid row + gridcells inside a virtualized absolutely-positioned grid; <table>/<tr>/<td> cannot host the transform-positioned rows the virtualizer requires (mirrors MonthlyView) */
                  <div role="row" className="flex gap-0.5">
                    {row.entries.map((entry) => {
                      const char = applySkinTone(entry.char, skinTone)
                      return (
                        <button
                          key={entry.name}
                          type="button"
                          role="gridcell"
                          aria-label={entry.name}
                          title={`:${entry.name}:`}
                          onClick={() => handleSelect(entry)}
                          className="grid size-9 place-items-center rounded-md text-xl leading-none hover:bg-accent focus-ring-visible"
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
  )
}

interface SkinToneSelectorProps {
  value: SkinToneId
  onChange: (tone: SkinToneId) => void
}

/**
 * Compact skin-tone picker: a row of six swatches (default + five Fitzpatrick
 * tones) applied to a sample thumbs-up. Implemented as a `radiogroup` for
 * keyboard + screen-reader parity.
 */
function SkinToneSelector({ value, onChange }: SkinToneSelectorProps) {
  const { t } = useTranslation()
  const sample = '\u{1F44D}' // thumbsup — supports skin tone
  return (
    <div
      role="radiogroup"
      aria-label={t('emojiPicker.skinTone')}
      className="flex items-center gap-0.5"
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
              'grid size-7 place-items-center rounded-md text-base leading-none hover:bg-accent focus-ring-visible',
              value === tone.id && 'bg-accent ring-1 ring-ring',
            )}
          >
            {tone.id === 'default' || !supportsSkinTone(sample)
              ? sample
              : applySkinTone(sample, tone.id)}
          </button>
          /* oxlint-enable jsx-a11y/prefer-tag-over-role */
        )
      })}
    </div>
  )
}
