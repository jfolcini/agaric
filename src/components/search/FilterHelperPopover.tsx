/**
 * `+ Filter ▾` helper popover.
 *
 * Categorised picker for the structural filter types:
 *   - Tag — opens an inline tag-name list (server-side filtered).
 *   - Page path (include) — opens an inline text-entry form.
 *   - Page path (exclude) — same but produces a `not-path:` token.
 *   - State / Priority / Property — Select-based builder forms with an
 * Include/exclude toggle, producing
 *     `state`/`notState`, `priority`/`notPriority`, `prop`/`notProp`.
 *   - Due / Scheduled — bucket-or-comparison date builder (no not-
 *     variant). The forms live under `./filter-forms/` and hand a fully
 *     built `FilterToken` (`span: [0, 0]`) back via `onAddFilter`.
 *
 * Single-popover-at-a-time pattern: clicking a category row swaps the
 * popover *content* in place rather than opening a nested popover.
 * Avoids Radix focus-trap issues.
 *
 * The tag picker is an ARIA combobox/listbox mirroring
 * `TagValuePicker`: the input owns `role="combobox"` +
 * `aria-activedescendant`, and the `<ul>` is a `role="listbox"` of
 * `role="option"` rows with ArrowUp/Down/Enter/Escape navigation.
 *
 * FE-A20 — the tag fetch is debounced *and* sequence-guarded: each
 * request bumps a ref counter and a stale (superseded) response is
 * dropped, so out-of-order IPC replies can never paint old suggestions.
 */

import type React from 'react'
import { useCallback, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { useDebouncedCallback } from '@/hooks/useDebouncedCallback'
import { logger } from '@/lib/logger'
import type { FilterToken } from '@/lib/search-query'
import { listTagsByPrefix, paginationLimit, type TagCacheRow } from '@/lib/tauri'

import { DateFilterForm } from './filter-forms/DateFilterForm'
import { PriorityFilterForm } from './filter-forms/PriorityFilterForm'
import { PropFilterForm } from './filter-forms/PropFilterForm'
import { StateFilterForm } from './filter-forms/StateFilterForm'

/**
 * #718 — a path glob cannot contain a literal `"` (mirrors
 * PropFilterForm's #152 value rule). The serialiser quotes globs with
 * whitespace, but the DSL has no escape syntax for `"` inside the
 * quotes, so a glob carrying its own quote characters would not survive
 * the serialise → re-parse round-trip.
 */
function isPathGlobValid(glob: string): boolean {
  return !/"/.test(glob)
}

type Mode =
  | 'menu'
  | 'tag'
  | 'pathInclude'
  | 'pathExclude'
  | 'state'
  | 'priority'
  | 'due'
  | 'scheduled'
  | 'prop'

const TAG_LISTBOX_ID = 'filter-helper-tag-listbox'
const tagOptionId = (tagId: string): string => `filter-helper-tag-option-${tagId}`

export interface FilterHelperPopoverProps {
  /** Add a tag filter to the AST (token form `tag:#name`). */
  onAddTag: (name: string) => void
  /** Add a `path:` glob filter (chip carries the raw glob). */
  onAddPathInclude: (glob: string) => void
  /** Add a `not-path:` glob filter. */
  onAddPathExclude: (glob: string) => void
  /**
   * Add a fully-built structural filter token
   * (state / priority / due / scheduled / prop and their not- variants).
   * The builder forms construct the token with `span: [0, 0]` and the
   * popover closes after calling this.
   */
  onAddFilter: (token: FilterToken) => void
}

export function FilterHelperPopover({
  onAddTag,
  onAddPathInclude,
  onAddPathExclude,
  onAddFilter,
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
  const pathErrorId = useId()
  const trimmedPath = pathInput.trim()
  const pathValid = isPathGlobValid(trimmedPath)
  // Only surface the error once the field is non-empty (same pattern as
  // PropFilterForm — don't yell at an empty form).
  const showPathError = trimmedPath !== '' && !pathValid

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
    // #718 — the serialiser wraps a glob containing whitespace in
    // `"..."` and the recogniser strips the quotes on parse, so values
    // like `Meeting Notes/*` round-trip. A literal `"` inside the glob
    // is rejected (mirrors PropFilterForm's #152 rule): the DSL has no
    // escape syntax, so a value like `My "Q" Notes/*` would serialise
    // to `path:"My "Q" Notes/*"` and fragment on re-parse.
    const v = pathInput.trim()
    if (!v || !isPathGlobValid(v)) return
    if (mode === 'pathInclude') onAddPathInclude(v)
    else if (mode === 'pathExclude') onAddPathExclude(v)
    handleOpenChange(false)
  }

  // The structural builder forms hand back a finished
  // token; route it to the parent and close the popover.
  function handleStructuralAdd(token: FilterToken) {
    onAddFilter(token)
    handleOpenChange(false)
  }
  const backToMenu = () => setMode('menu')

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
            {/* a role="menu" must contain only menuitem children
                (axe aria-required-children); the tip sits OUTSIDE it. */}
            <div role="menu" aria-label={t('search.addFilter')}>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={openTagMode}>
                <span className="font-medium">{t('search.filterCategory.tag')}</span>
                <span className="ml-2 text-xs text-muted-foreground">tag:#name</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={() => setMode('pathInclude')}>
                <span className="font-medium">{t('search.filterCategory.pathInclude')}</span>
                <span className="ml-2 text-xs text-muted-foreground">path:Journal/*</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={() => setMode('pathExclude')}>
                <span className="font-medium">{t('search.filterCategory.pathExclude')}</span>
                <span className="ml-2 text-xs text-muted-foreground">not-path:Archive/**</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={() => setMode('state')}>
                <span className="font-medium">{t('search.filterCategory.state')}</span>
                <span className="ml-2 text-xs text-muted-foreground">state:TODO</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={() => setMode('priority')}>
                <span className="font-medium">{t('search.filterCategory.priority')}</span>
                <span className="ml-2 text-xs text-muted-foreground">priority:1</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={() => setMode('due')}>
                <span className="font-medium">{t('search.filterCategory.due')}</span>
                <span className="ml-2 text-xs text-muted-foreground">due:today</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={() => setMode('scheduled')}>
                <span className="font-medium">{t('search.filterCategory.scheduled')}</span>
                <span className="ml-2 text-xs text-muted-foreground">scheduled:next-week</span>
              </PopoverMenuItem>
              <PopoverMenuItem role="menuitem" tabIndex={0} onClick={() => setMode('prop')}>
                <span className="font-medium">{t('search.filterCategory.prop')}</span>
                <span className="ml-2 text-xs text-muted-foreground">prop:key=value</span>
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
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- explicit role="combobox" on the tag-query <input> drives the aria-activedescendant listbox below; the native combobox mapping differs and would drop the aria-expanded/aria-controls wiring this custom popup relies on
              role="combobox"
              // The input is the actual text-entry field, so it must stay in
              // the tab order (`tabIndex={0}`); `interactive-supports-focus`
              // can't infer focusability from the native <input> once an
              // explicit `role` is present.
              tabIndex={0}
              aria-autocomplete="list"
              // The `<ul role="listbox">` is always mounted in tag mode (it
              // renders a loading row / "No tags found" row), so the combobox
              // must report expanded even while suggestions are loading/empty.
              aria-expanded={true}
              aria-controls={TAG_LISTBOX_ID}
              {...(activeDescendant ? { 'aria-activedescendant': activeDescendant } : {})}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- this combobox renders only after the user switches into tag mode inside the open filter popover; focusing it lets them type the tag query immediately (the listbox below is driven by this input via aria-activedescendant)
              autoFocus
            />
            <ul
              id={TAG_LISTBOX_ID}
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role, jsx-a11y/prefer-tag-over-role -- `<ul role="listbox">` is the canonical WAI-ARIA listbox container for the combobox popup (mirrors VirtualizedResultListbox / SearchHistoryDropdown); keyboard activation flows through aria-activedescendant on the input, and <datalist>/<select> can't host the per-option <button> rows this widget uses.
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
                      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- role="option" on the <button> row of the custom combobox listbox; the native <option> tag can't carry a clickable button with hover/focus styling
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
              aria-invalid={showPathError || undefined}
              aria-errormessage={showPathError ? pathErrorId : undefined}
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- this path input renders only after the user switches into pathInclude/pathExclude mode inside the open filter popover; focusing it lets them type the path immediately without an extra click/tab
              autoFocus
            />
            {showPathError ? (
              <p id={pathErrorId} role="alert" className="mt-1 text-xs text-destructive">
                {t('search.filterHelper.pathValueInvalid')}
              </p>
            ) : null}
            <div className="mt-2 flex gap-2 justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode('menu')}>
                {t('search.filterHelper.back')}
              </Button>
              <Button type="submit" size="sm" disabled={!trimmedPath || !pathValid}>
                {t('search.filterHelper.add')}
              </Button>
            </div>
          </form>
        )}
        {mode === 'state' && (
          <StateFilterForm onAddFilter={handleStructuralAdd} onBack={backToMenu} />
        )}
        {mode === 'priority' && (
          <PriorityFilterForm onAddFilter={handleStructuralAdd} onBack={backToMenu} />
        )}
        {(mode === 'due' || mode === 'scheduled') && (
          <DateFilterForm kind={mode} onAddFilter={handleStructuralAdd} onBack={backToMenu} />
        )}
        {mode === 'prop' && (
          <PropFilterForm onAddFilter={handleStructuralAdd} onBack={backToMenu} />
        )}
      </PopoverContent>
    </Popover>
  )
}
