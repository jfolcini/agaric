/**
 * PEND-54 — `+ Filter ▾` helper popover.
 *
 * Categorised picker for the three filter types this plan ships:
 *   - Tag — opens an inline tag-name list (server-side filtered).
 *   - Page path (include) — opens an inline text-entry form.
 *   - Page path (exclude) — same but produces a `not-path:` token.
 *
 * Single-popover-at-a-time pattern: clicking a category row swaps the
 * popover *content* in place rather than opening a nested popover.
 * Avoids Radix focus-trap issues.
 *
 * The tag picker is an ARIA combobox/listbox (UX-A6) mirroring
 * `TagValuePicker`: the input owns `role="combobox"` +
 * `aria-activedescendant`, and the `<ul>` is a `role="listbox"` of
 * `role="option"` rows with ArrowUp/Down/Enter/Escape navigation.
 *
 * FE-A20 — the tag fetch is debounced *and* sequence-guarded: each
 * request bumps a ref counter and a stale (superseded) response is
 * dropped, so out-of-order IPC replies can never paint old suggestions.
 */

import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { logger } from '@/lib/logger'
import { listTagsByPrefix, paginationLimit, type TagCacheRow } from '@/lib/tauri'

type Mode = 'menu' | 'tag' | 'pathInclude' | 'pathExclude'

const TAG_LISTBOX_ID = 'filter-helper-tag-listbox'
const tagOptionId = (tagId: string): string => `filter-helper-tag-option-${tagId}`

export interface FilterHelperPopoverProps {
  /** Add a tag filter to the AST (token form `tag:#name`). */
  onAddTag: (name: string) => void
  /** Add a `path:` glob filter (chip carries the raw glob). */
  onAddPathInclude: (glob: string) => void
  /** Add a `not-path:` glob filter. */
  onAddPathExclude: (glob: string) => void
}

export function FilterHelperPopover({
  onAddTag,
  onAddPathInclude,
  onAddPathExclude,
}: FilterHelperPopoverProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<Mode>('menu')

  // Tag mode state.
  const [tagQuery, setTagQuery] = useState('')
  const [tagSuggestions, setTagSuggestions] = useState<TagCacheRow[]>([])
  const [tagLoading, setTagLoading] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)

  // FE-A20 — latest-wins sequence guard: every fetch bumps the counter and
  // only the most-recently-issued request is allowed to commit its result,
  // so an out-of-order/superseded IPC reply is dropped.
  const requestSeq = useRef(0)

  // Path mode state.
  const [pathInput, setPathInput] = useState('')

  function reset() {
    setMode('menu')
    setTagQuery('')
    setTagSuggestions([])
    setActiveIndex(-1)
    setPathInput('')
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) reset()
  }

  const runFetch = useCallback(
    async (q: string) => {
      const seq = ++requestSeq.current
      setTagLoading(true)
      try {
        const tags = await listTagsByPrefix({ prefix: q, limit: paginationLimit(20) })
        // Drop superseded responses (FE-A20).
        if (seq !== requestSeq.current) return
        setTagSuggestions(tags)
        setActiveIndex(-1)
      } catch (err) {
        if (seq !== requestSeq.current) return
        // Matches the fire-and-forget IPC-failure logging used by the other
        // `listTagsByPrefix` callers (TagValuePicker, HasTagFilterForm).
        logger.warn('FilterHelperPopover', 'failed to search tags', { prefix: q }, err)
        setTagSuggestions([])
        setActiveIndex(-1)
      } finally {
        if (seq === requestSeq.current) setTagLoading(false)
      }
    },
    [], // only stable refs (setters, module-level fns) are read.
  )

  const debouncedFetch = useDebouncedCallback((q: string) => {
    void runFetch(q)
  }, 150)

  // Opening the tag category needs an immediate (un-debounced) prefill so the
  // list is populated the moment the panel appears.
  const openTagMode = useCallback(() => {
    setMode('tag')
    debouncedFetch.cancel()
    void runFetch('')
  }, [debouncedFetch, runFetch])

  function handleTagQueryChange(v: string) {
    setTagQuery(v)
    setActiveIndex(-1)
    debouncedFetch.schedule(v)
  }

  function handleTagSelect(tag: TagCacheRow) {
    onAddTag(tag.name)
    handleOpenChange(false)
  }

  function handleTagKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        if (tagSuggestions.length === 0) return
        e.preventDefault()
        setActiveIndex((prev) => Math.min(prev + 1, tagSuggestions.length - 1))
        break
      case 'ArrowUp':
        if (tagSuggestions.length === 0) return
        e.preventDefault()
        setActiveIndex((prev) => Math.max(prev - 1, 0))
        break
      case 'Enter': {
        const item = tagSuggestions[activeIndex]
        if (activeIndex >= 0 && item) {
          e.preventDefault()
          handleTagSelect(item)
        }
        break
      }
      case 'Escape':
        e.preventDefault()
        handleOpenChange(false)
        break
    }
  }

  function submitPathFilter() {
    const v = pathInput.trim()
    if (!v) return
    if (mode === 'pathInclude') onAddPathInclude(v)
    else if (mode === 'pathExclude') onAddPathExclude(v)
    handleOpenChange(false)
  }

  const tagListExpanded = tagSuggestions.length > 0
  const activeDescendant =
    activeIndex >= 0 && tagSuggestions[activeIndex]
      ? tagOptionId(tagSuggestions[activeIndex].tag_id)
      : undefined

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          type="button"
          data-testid="add-filter-button"
          aria-label={t('search.addFilter')}
        >
          {t('search.addFilter')}
          <span aria-hidden="true" className="ml-1">
            ▾
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72" aria-label={t('search.addFilter')}>
        {mode === 'menu' && (
          <div data-testid="filter-helper-menu">
            {/* UX-A6 — a role="menu" must contain only menuitem children
                (axe aria-required-children); the tip sits OUTSIDE it. */}
            <div role="menu" aria-label={t('search.addFilter')}>
              <PopoverMenuItem role="menuitem" onClick={openTagMode}>
                <span className="font-medium">{t('search.filterCategory.tag')}</span>
                <span className="ml-2 text-xs text-muted-foreground">tag:#name</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" onClick={() => setMode('pathInclude')}>
                <span className="font-medium">{t('search.filterCategory.pathInclude')}</span>
                <span className="ml-2 text-xs text-muted-foreground">path:Journal/*</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" onClick={() => setMode('pathExclude')}>
                <span className="font-medium">{t('search.filterCategory.pathExclude')}</span>
                <span className="ml-2 text-xs text-muted-foreground">not-path:Archive/**</span>
              </PopoverMenuItem>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t('search.filterCategoryTip')}</p>
          </div>
        )}
        {mode === 'tag' && (
          <div data-testid="filter-helper-tag">
            <Input
              type="text"
              value={tagQuery}
              onChange={(e) => handleTagQueryChange(e.target.value)}
              onKeyDown={handleTagKeyDown}
              placeholder={t('search.searchTags')}
              aria-label={t('search.searchTags')}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={tagListExpanded}
              aria-controls={tagListExpanded ? TAG_LISTBOX_ID : undefined}
              {...(activeDescendant ? { 'aria-activedescendant': activeDescendant } : {})}
              autoFocus
            />
            <ul
              id={TAG_LISTBOX_ID}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: `<ul role="listbox">` is the canonical WAI-ARIA listbox container for the combobox popup (mirrors VirtualizedResultListbox / SearchHistoryDropdown); keyboard activation flows through aria-activedescendant on the input.
              role="listbox"
              className="mt-2 max-h-60 overflow-y-auto list-none m-0 p-0"
              aria-label={t('search.filterHelper.tagResultsLabel')}
            >
              {tagLoading && (
                <li role="presentation" className="px-2 py-1 text-xs text-muted-foreground">
                  …
                </li>
              )}
              {!tagLoading && tagSuggestions.length === 0 && (
                <li role="presentation" className="px-2 py-1 text-xs text-muted-foreground">
                  {t('search.noTagsFound')}
                </li>
              )}
              {!tagLoading &&
                tagSuggestions.map((tag, idx) => (
                  <li key={tag.tag_id} role="presentation">
                    <button
                      type="button"
                      id={tagOptionId(tag.tag_id)}
                      role="option"
                      aria-selected={idx === activeIndex}
                      tabIndex={-1}
                      onClick={() => handleTagSelect(tag)}
                      className="w-full text-left px-2 py-1 rounded hover:bg-muted focus-ring-visible text-sm [@media(pointer:coarse)]:min-h-11 data-[active=true]:bg-muted"
                      data-active={idx === activeIndex}
                    >
                      #{tag.name}
                    </button>
                  </li>
                ))}
            </ul>
            <div className="mt-2 flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode('menu')}>
                {t('search.filterHelper.back')}
              </Button>
            </div>
          </div>
        )}
        {(mode === 'pathInclude' || mode === 'pathExclude') && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submitPathFilter()
            }}
            data-testid="path-filter-input"
          >
            <label htmlFor="filter-path-input" className="text-sm font-medium">
              {mode === 'pathInclude'
                ? t('search.filterCategory.pathInclude')
                : t('search.filterCategory.pathExclude')}
            </label>
            <Input
              id="filter-path-input"
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              placeholder={t('search.filterHelper.pathPlaceholder')}
              className="mt-2"
              autoFocus
            />
            <div className="mt-2 flex gap-2 justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode('menu')}>
                {t('search.filterHelper.back')}
              </Button>
              <Button type="submit" size="sm" disabled={!pathInput.trim()}>
                {t('search.filterHelper.add')}
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  )
}
