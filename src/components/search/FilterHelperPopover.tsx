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
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { PopoverMenuItem } from '@/components/ui/popover-menu-item'
import { listTagsByPrefix, paginationLimit, type TagCacheRow } from '@/lib/tauri'

type Mode = 'menu' | 'tag' | 'pathInclude' | 'pathExclude'

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

  // Path mode state.
  const [pathInput, setPathInput] = useState('')

  function reset() {
    setMode('menu')
    setTagQuery('')
    setTagSuggestions([])
    setPathInput('')
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) reset()
  }

  async function fetchTags(q: string) {
    setTagLoading(true)
    try {
      const tags = await listTagsByPrefix({ prefix: q, limit: paginationLimit(20) })
      setTagSuggestions(tags)
    } finally {
      setTagLoading(false)
    }
  }

  function handleTagSelect(tag: TagCacheRow) {
    onAddTag(tag.name)
    handleOpenChange(false)
  }

  function submitPathFilter() {
    const v = pathInput.trim()
    if (!v) return
    if (mode === 'pathInclude') onAddPathInclude(v)
    else if (mode === 'pathExclude') onAddPathExclude(v)
    handleOpenChange(false)
  }

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
      <PopoverContent align="start" className="w-72">
        {mode === 'menu' && (
          <div data-testid="filter-helper-menu" role="menu">
            <PopoverMenuItem
              onSelect={() => {
                setMode('tag')
                void fetchTags('')
              }}
            >
              <span className="font-medium">{t('search.filterCategory.tag')}</span>
              <span className="ml-2 text-xs text-muted-foreground">tag:#name</span>
            </PopoverMenuItem>
            <PopoverMenuItem onSelect={() => setMode('pathInclude')}>
              <span className="font-medium">{t('search.filterCategory.pathInclude')}</span>
              <span className="ml-2 text-xs text-muted-foreground">path:Journal/*</span>
            </PopoverMenuItem>
            <PopoverMenuItem onSelect={() => setMode('pathExclude')}>
              <span className="font-medium">{t('search.filterCategory.pathExclude')}</span>
              <span className="ml-2 text-xs text-muted-foreground">not-path:Archive/**</span>
            </PopoverMenuItem>
            <p className="mt-2 text-xs text-muted-foreground">{t('search.filterCategoryTip')}</p>
          </div>
        )}
        {mode === 'tag' && (
          <div data-testid="filter-helper-tag">
            <Input
              type="text"
              value={tagQuery}
              onChange={(e) => {
                const v = e.target.value
                setTagQuery(v)
                void fetchTags(v)
              }}
              placeholder={t('search.searchTags')}
              aria-label={t('search.searchTags')}
              autoFocus
            />
            <ul
              className="mt-2 max-h-60 overflow-y-auto list-none m-0 p-0"
              aria-label={t('search.filterCategory.tag')}
            >
              {tagLoading && <li className="px-2 py-1 text-xs text-muted-foreground">…</li>}
              {!tagLoading && tagSuggestions.length === 0 && (
                <li className="px-2 py-1 text-xs text-muted-foreground">
                  {t('search.noTagsFound')}
                </li>
              )}
              {tagSuggestions.map((tag) => (
                <li key={tag.tag_id}>
                  <button
                    type="button"
                    onClick={() => handleTagSelect(tag)}
                    className="w-full text-left px-2 py-1 rounded hover:bg-muted focus-ring-visible text-sm"
                  >
                    #{tag.name}
                  </button>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode('menu')}>
                Back
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
              placeholder="Journal/2026-*"
              className="mt-2"
              autoFocus
            />
            <div className="mt-2 flex gap-2 justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode('menu')}>
                Back
              </Button>
              <Button type="submit" size="sm" disabled={!pathInput.trim()}>
                Add
              </Button>
            </div>
          </form>
        )}
      </PopoverContent>
    </Popover>
  )
}
