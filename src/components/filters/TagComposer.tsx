/**
 * TagComposer — a single-level tag-query builder (#1426).
 *
 * Surfaces the two backend tag capabilities the flat `query_by_tags` IPC can
 * FAITHFULLY express but the panel previously hid: prefix-search leaves, and a
 * builder that intermixes resolved-tag and name-prefix leaves under one
 * combinator (All / Any / None). The combinator maps 1:1 onto the IPC `mode`
 * (`and` / `or` / `not`).
 *
 * It is intentionally NOT a nested/recursive builder: the only tag-query IPC is
 * flat, so deep nesting and per-leaf negation cannot be executed — a UI that
 * offered them would silently flatten/drop the structure and run a different
 * query than the one on screen. The recursive nested-boolean builder lives on
 * the advanced-query surface (#1280, `QueryBuilderModal`), which has its own
 * expression IPC; this panel sticks to what `query_by_tags` can run.
 *
 * The component is a thin controlled view over a {@link TagBuilder}: every edit
 * dispatches a callback; the compiled wire params are produced by
 * `compileTagBuilder` in `@/lib/tagExpr` and consumed by the parent panel.
 */

import { Plus, Search } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { FilterPill } from '@/components/ui/filter-pill'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SearchInput } from '@/components/ui/search-input'
import {
  type TagBuilder,
  type TagBuilderLeaf,
  addLeaf,
  emptyTagBuilder,
  makePrefixLeaf,
  makeTagLeaf,
  removeLeaf,
  setMode,
} from '@/lib/tagExpr'
import { listTagsByPrefix } from '@/lib/tauri'
import { cn } from '@/lib/utils'

export interface TagComposerCallbacks {
  /** Append a resolved tag leaf. */
  onAddTag: (tagId: string, name: string) => void
  /** Append a prefix leaf. */
  onAddPrefix: (prefix: string) => void
  /** Remove the leaf with `id`. */
  onRemoveLeaf: (id: number) => void
  /** Set the All/Any/None combinator (the IPC `mode`). */
  onSetMode: (mode: TagBuilder['mode']) => void
}

/**
 * Owns the composer builder + all of its edit callbacks (#1426). `builder` is
 * `null` while the composer is closed (so the panel runs its flat default).
 */
export function useTagComposerState(): {
  builder: TagBuilder | null
  callbacks: TagComposerCallbacks
  toggle: () => void
} {
  const [builder, setBuilder] = useState<TagBuilder | null>(null)

  const onAddTag = useCallback((tagId: string, name: string) => {
    setBuilder((b) => addLeaf(b ?? emptyTagBuilder(), makeTagLeaf(tagId, name)))
  }, [])
  const onAddPrefix = useCallback((prefix: string) => {
    setBuilder((b) => addLeaf(b ?? emptyTagBuilder(), makePrefixLeaf(prefix)))
  }, [])
  const onRemoveLeaf = useCallback((id: number) => {
    setBuilder((b) => (b ? removeLeaf(b, id) : b))
  }, [])
  const onSetMode = useCallback((mode: TagBuilder['mode']) => {
    setBuilder((b) => (b ? setMode(b, mode) : b))
  }, [])
  const toggle = useCallback(() => {
    setBuilder((b) => (b == null ? emptyTagBuilder() : null))
  }, [])

  const callbacks = useMemo<TagComposerCallbacks>(
    () => ({ onAddTag, onAddPrefix, onRemoveLeaf, onSetMode }),
    [onAddTag, onAddPrefix, onRemoveLeaf, onSetMode],
  )

  return { builder, callbacks, toggle }
}

interface TagComposerProps extends TagComposerCallbacks {
  /** The builder to render. */
  builder: TagBuilder
}

/** All/Any/None combinator — a 3-way segmented radiogroup over the IPC `mode`. */
function ModeToggle({
  mode,
  onSetMode,
}: {
  mode: TagBuilder['mode']
  onSetMode: (mode: TagBuilder['mode']) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const options: { value: TagBuilder['mode']; label: string }[] = [
    { value: 'and', label: t('tagFilter.composer.opAnd') },
    { value: 'or', label: t('tagFilter.composer.opOr') },
    { value: 'not', label: t('tagFilter.composer.opNot') },
  ]
  return (
    <div
      className="inline-flex rounded-md border"
      role="radiogroup"
      aria-label={t('tagFilter.composer.opLabel')}
    >
      {options.map(({ value, label }) => {
        const selected = mode === value
        return (
          <button
            key={value}
            type="button"
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a real radio <input> can't render as a flush segmented-toggle button; the radiogroup/radio/aria-checked semantics are explicit and accessible
            role="radio"
            aria-checked={selected}
            aria-label={label}
            onClick={() => onSetMode(value)}
            className={cn(
              'h-7 px-2.5 text-xs first:rounded-l-md last:rounded-r-md focus-ring-visible',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'bg-background hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {label}
          </button>
        )
      })}
    </div>
  )
}

/** A tag or prefix leaf rendered as a removable pill. */
function LeafChip({
  leaf,
  onRemoveLeaf,
}: {
  leaf: TagBuilderLeaf
  onRemoveLeaf: (id: number) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const label =
    leaf.kind === 'tag'
      ? leaf.name
      : t('tagFilter.composer.prefixLeafLabel', { prefix: leaf.prefix })
  return (
    <li className="inline-flex items-center gap-1" data-testid="tag-composer-leaf">
      <FilterPill
        label={label}
        onRemove={() => onRemoveLeaf(leaf.id)}
        removeAriaLabel={t('tagFilter.composer.removeLeaf', { label })}
        groupAriaLabel={label}
      />
    </li>
  )
}

/** Typeahead popover that resolves a tag prefix and adds tag/prefix leaves. */
function AddTagPopover({
  onAddTag,
  onAddPrefix,
}: {
  onAddTag: (tagId: string, name: string) => void
  onAddPrefix: (prefix: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ tag_id: string; name: string; usage_count: number }[]>(
    [],
  )

  async function search(value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) {
      setMatches([])
      return
    }
    try {
      const tags = await listTagsByPrefix({ prefix: trimmed })
      setMatches(
        tags.map((tg) => ({ tag_id: tg.tag_id, name: tg.name, usage_count: tg.usage_count })),
      )
    } catch {
      setMatches([])
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={t('tagFilter.composer.addTag')}
        >
          <Plus className="h-3 w-3" aria-hidden="true" />
          {t('tagFilter.composer.addTag')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2 p-2" align="start">
        <div className="flex items-center gap-2">
          <SearchInput
            value={query}
            onChange={(e) => {
              const v = e.target.value
              setQuery(v)
              void search(v)
            }}
            placeholder={t('tagFilter.composer.searchPlaceholder')}
            aria-label={t('tagFilter.composer.searchLabel')}
            className="flex-1"
          />
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>

        {/* Add the typed text as a prefix leaf. */}
        {query.trim().length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-full justify-start"
            onClick={() => {
              onAddPrefix(query.trim())
              setQuery('')
              setMatches([])
              setOpen(false)
            }}
          >
            {t('tagFilter.composer.addPrefixOption', { prefix: query.trim() })}
          </Button>
        )}

        {/* Resolved tag matches. */}
        {matches.length > 0 && (
          <ul className="m-0 max-h-48 list-none space-y-0.5 overflow-y-auto p-0">
            {matches.map((tag) => (
              <li key={tag.tag_id}>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="w-full justify-between"
                  onClick={() => {
                    onAddTag(tag.tag_id, tag.name)
                    setQuery('')
                    setMatches([])
                    setOpen(false)
                  }}
                >
                  <span className="truncate">{tag.name}</span>
                  <span className="text-muted-foreground">({tag.usage_count})</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function TagComposer({
  builder,
  onAddTag,
  onAddPrefix,
  onRemoveLeaf,
  onSetMode,
}: TagComposerProps): React.ReactElement {
  const { t } = useTranslation()

  return (
    <div
      className="tag-composer-group flex flex-col gap-2 rounded-md border p-2"
      data-testid="tag-composer-group"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <fieldset> would impose form semantics and break the inline builder layout; role=group is the correct grouping primitive for this composite control
      role="group"
      aria-label={t('tagFilter.composer.rootLabel')}
    >
      {/* Combinator header. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('tagFilter.composer.opLabel')}</span>
        <ModeToggle mode={builder.mode} onSetMode={onSetMode} />
      </div>

      {/* Leaves — tags + prefixes intermixed in order. */}
      {builder.leaves.length === 0 ? (
        <p className="px-1 text-xs text-muted-foreground" data-testid="tag-composer-empty">
          {t('tagFilter.composer.emptyGroup')}
        </p>
      ) : (
        <ul className="m-0 flex flex-wrap gap-2 list-none p-0">
          {builder.leaves.map((leaf) => (
            <LeafChip key={leaf.id} leaf={leaf} onRemoveLeaf={onRemoveLeaf} />
          ))}
        </ul>
      )}

      {/* Add affordance. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <AddTagPopover onAddTag={onAddTag} onAddPrefix={onAddPrefix} />
      </div>
    </div>
  )
}
