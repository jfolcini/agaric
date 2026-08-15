/**
 * GraphFilterBar — multi-dimension filter UI for the graph view.
 *
 * Shows each active filter as a removable pill, plus a `t('graph.filter.addFilter')` button
 * that opens a popover for picking a dimension and value. Built on top of
 * `FilterPill`, Radix `Popover`, and `Select` primitives — no custom
 * overlays or classes.
 *
 * Controlled component: parent owns the `filters` array and receives change
 * notifications via `onFiltersChange`. Duplicate filters of the same type are
 * replaced rather than stacked.
 */

import type { TFunction } from 'i18next'
import { Filter, Plus, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FilterPill } from '@/components/ui/filter-pill'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'
import { canonicalToGraphFilters, graphFiltersToCanonical } from '@/lib/filters/model'
import { parseFilterPredicates } from '@/lib/filters/validate'
import {
  GRAPH_STATUS_VALUES,
  type GraphFilter,
  type GraphFilterType,
  getGraphFilterKey,
} from '@/lib/graph-filters'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'

/**
 * LocalStorage key for persisting the user's graph filters across
 * navigation. Stored as a JSON-serialised `GraphFilter[]`. Reads + writes are
 * wrapped in `try/catch` to survive corrupted or unavailable storage (private
 * browsing, quota exceeded, SSR), and guarded by `typeof window !==
 * 'undefined'` so this component can render in non-browser test runners.
 */
const STORAGE_KEY = 'agaric:graph-filters'

/** Tag shape accepted by the tag-dimension selector. Compatible with `TagCacheRow`. */
export interface GraphFilterBarTag {
  tag_id: string
  name: string
}

/**
 * Narrow an `unknown` value to the legacy `GraphFilter` shape (#3881 — the
 * bare `parsed as GraphFilter[]` assertion in `readPersistedFilters` below
 * used to trust the parsed JSON outright; this validates every field the
 * `type` discriminant claims, not just the discriminant itself). An
 * unrecognised `type` is rejected outright, matching `isFilterPredicate`'s
 * discipline for the canonical branch below it
 * (`src/lib/filters/validate.ts`).
 */
function isLegacyGraphFilter(value: unknown): value is GraphFilter {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  switch (v['type']) {
    case 'tag': {
      return Array.isArray(v['tagIds']) && v['tagIds'].every((t) => typeof t === 'string')
    }
    case 'status':
    case 'priority': {
      return Array.isArray(v['values']) && v['values'].every((t) => typeof t === 'string')
    }
    case 'hasDueDate':
    case 'hasScheduledDate':
    case 'hasBacklinks':
    case 'excludeTemplates': {
      return typeof v['value'] === 'boolean'
    }
    default: {
      return false
    }
  }
}

/**
 * Read the persisted filter list from localStorage. Returns `null` when no
 * value is stored, when storage is unavailable (SSR), or when the stored value
 * fails to parse.
 *
 * Issue #1646 proof: the graph surface now persists its filters as CANONICAL
 * `FilterPredicate[]` (the single cross-surface model) and projects them back
 * to the surface-local `GraphFilter[]` on read via
 * `canonicalToGraphFilters`. The canonical model is therefore the source of
 * truth at the persistence boundary; `GraphView` / `applyGraphFilters` and the
 * `GraphFilter[]` prop contract are unchanged.
 *
 * A legacy stored value (pre-migration `GraphFilter[]`, lacking a `kind`
 * discriminant) is still accepted: it is read straight through as
 * `GraphFilter[]`, then re-persisted in canonical form on the next write.
 *
 * #3791: the `looksCanonical` sniff below only confirms each entry has a
 * string `kind` — it does not check that the entry's other fields match the
 * shape that `kind` claims. `parsed` is `unknown` fresh out of `JSON.parse`,
 * so a stale entry from an older schema, a hand-edited devtools value, or a
 * future migration can pass the sniff while carrying wrong-typed or
 * borrowed-from-another-variant fields. `parseFilterPredicates` runs the
 * real per-`kind` validator (`src/lib/filters/validate.ts`) over the array
 * and drops any entry that fails — including one with an unrecognised
 * `kind` — before the survivors ever reach `canonicalToGraphFilters`.
 *
 * #3889: when every entry is dropped, `predicates` is `[]`. The caller's
 * mount effect never dispatches an empty hydrated list (see below), so the
 * normal write-effect self-heal — persisting the cleaned value once
 * `filters` changes — never fires either: nothing changed from the parent's
 * point of view. Left alone, the wholly-corrupt value would sit in storage
 * forever and re-warn on every mount. So this is the one case where the read
 * path writes back itself, overwriting the corrupt value with the (empty)
 * cleaned one right here, rather than leaving it to the write effect.
 *
 * Narrow cross-version caveat: if every stored entry is actually valid for a
 * NEWER schema this validator doesn't recognise yet (e.g. after a downgrade
 * to an older build), the heal above overwrites those entries with `[]`
 * where they previously just sat there unread. Only reachable on a
 * downgrade, and the current version already ignored those entries either
 * way (it can't validate a shape it doesn't know), so nothing this version
 * does with the data changes — only what a future re-upgrade could still
 * have recovered from disk.
 */

function readPersistedFilters(): GraphFilter[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    // Canonical predicates carry a `kind` discriminant; legacy graph filters
    // carry `type`. Detect and project canonical → graph; pass legacy through.
    const looksCanonical = parsed.every(
      (e): e is Record<string, unknown> =>
        typeof e === 'object' && e !== null && 'kind' in e && typeof e.kind === 'string',
    )
    if (looksCanonical) {
      const { predicates, droppedCount } = parseFilterPredicates(parsed)
      if (droppedCount > 0) {
        logger.warn('GraphFilterBar', 'Dropped invalid persisted filter predicates', {
          key: STORAGE_KEY,
          droppedCount,
        })
        if (predicates.length === 0) {
          // Total corruption (#3889): nothing survived, so hydration below
          // dispatches nothing and the write effect that would normally
          // persist the cleaned value never runs. Self-heal here instead —
          // overwrite the corrupt stored value with the (empty) cleaned one
          // so the next mount finds a clean `[]` and stops re-warning.
          //
          // This write gets its own try/catch, deliberately separate from
          // the outer read `try` below: a throw here is a WRITE failure
          // (quota exceeded, storage revoked mid-read), not a read failure,
          // and must not be misattributed to "Failed to read persisted
          // filters" — the outer catch's message. The heal is best-effort;
          // the cleaned `[]` is still returned either way.
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(predicates))
          } catch (err) {
            logger.warn(
              'GraphFilterBar',
              'Failed to persist healed (self-cleaned) filters',
              { key: STORAGE_KEY },
              err,
            )
          }
        }
      }
      return canonicalToGraphFilters(predicates)
    }
    const legacyFilters: GraphFilter[] = []
    let legacyDroppedCount = 0
    for (const entry of parsed) {
      if (isLegacyGraphFilter(entry)) legacyFilters.push(entry)
      else legacyDroppedCount++
    }
    if (legacyDroppedCount > 0) {
      logger.warn('GraphFilterBar', 'Dropped invalid persisted legacy filters', {
        key: STORAGE_KEY,
        droppedCount: legacyDroppedCount,
      })
      if (legacyFilters.length === 0) {
        // Same total-corruption case as the canonical branch above (#3889):
        // an empty hydrated list is never dispatched by the mount effect, so
        // the normal write-effect self-heal never fires either. Heal here
        // too, in its own try/catch for the same write-vs-read attribution
        // reason as above.
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(legacyFilters))
        } catch (err) {
          logger.warn(
            'GraphFilterBar',
            'Failed to persist healed (self-cleaned) filters',
            { key: STORAGE_KEY },
            err,
          )
        }
      }
    }
    return legacyFilters
  } catch (err) {
    logger.warn('GraphFilterBar', 'Failed to read persisted filters', { key: STORAGE_KEY }, err)
    return null
  }
}

/**
 * Write the current filter list to localStorage as canonical
 * `FilterPredicate[]`. No-ops on SSR / storage errors. See
 * `readPersistedFilters` for the round-trip contract.
 */
function writePersistedFilters(filters: GraphFilter[]): void {
  if (typeof window === 'undefined') return
  try {
    const canonical = graphFiltersToCanonical(filters)
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(canonical))
  } catch (err) {
    logger.warn('GraphFilterBar', 'Failed to persist filters', { key: STORAGE_KEY }, err)
  }
}

export interface GraphFilterBarProps {
  /** Current filter list. Controlled. */
  filters: GraphFilter[]
  /** Called with the next filter list whenever the user adds/removes/clears. */
  onFiltersChange: (filters: GraphFilter[]) => void
  /** Tag catalogue used to populate the tag dimension. */
  allTags: GraphFilterBarTag[]
  /** Optional total count of pages — used for the "showing N of M" label. */
  totalCount?: number | undefined
  /** Optional filtered count of pages — used for the "showing N of M" label. */
  filteredCount?: number | undefined
  /**
   * Optional count of link edges actually on screen (post client-side
   * dimension filtering) — the N in the "showing N of M links" truncation
   * notice (#2298 count-then-cap).
   */
  edgesShown?: number | undefined
  /**
   * Optional TRUE total of link edges matching the fetch filters, computed
   * independently of the backend edge cap — the M in the notice (#2298).
   */
  edgesTotal?: number | undefined
  /** True when the backend edge cap fired and `edgesShown < edgesTotal` (#2298). */
  edgesTruncated?: boolean | undefined
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a single filter (used inside the pill). */
function filterLabel(filter: GraphFilter, t: TFunction): string {
  switch (filter.type) {
    case 'tag': {
      // Robustness: an empty set is a match-everything no-op (the Add-filter
      // form now prevents constructing one — #2260); never render 'Tag: 0'.
      return filter.tagIds.length === 0
        ? t('graph.filter.tag')
        : `${t('graph.filter.tag')}: ${filter.tagIds.length}`
    }
    case 'status': {
      return filter.values.length === 0
        ? t('graph.filter.status')
        : `${t('graph.filter.status')}: ${filter.values.join(', ')}`
    }
    case 'priority': {
      return filter.values.length === 0
        ? t('graph.filter.priority')
        : `${t('graph.filter.priority')}: ${filter.values.join(', ')}`
    }
    case 'hasDueDate': {
      return `${t('graph.filter.hasDueDate')}: ${filter.value ? t('graph.filter.yes') : t('graph.filter.no')}`
    }
    case 'hasScheduledDate': {
      return `${t('graph.filter.hasScheduledDate')}: ${filter.value ? t('graph.filter.yes') : t('graph.filter.no')}`
    }
    case 'hasBacklinks': {
      return `${t('graph.filter.hasBacklinks')}: ${filter.value ? t('graph.filter.yes') : t('graph.filter.no')}`
    }
    case 'excludeTemplates': {
      return t('graph.filter.excludeTemplates')
    }
  }
}

// ---------------------------------------------------------------------------
// Add-filter popover contents
// ---------------------------------------------------------------------------

interface AddFilterFormProps {
  allTags: GraphFilterBarTag[]
  existingFilters: GraphFilter[]
  onApply: (filter: GraphFilter) => void
  onCancel: () => void
}

function AddFilterForm({
  allTags,
  existingFilters,
  onApply,
  onCancel,
}: AddFilterFormProps): React.ReactElement {
  const { t } = useTranslation()

  // Subscribe to the user-configured priority levels so the
  // filter checkbox list reflects the live set without a reload.
  const priorityLevels = usePriorityLevels()

  const [dimension, setDimension] = useState<GraphFilterType | ''>('')

  // Per-dimension state — kept separate so switching dimensions doesn't clobber
  // half-typed values.
  const [tagIds, setTagIds] = useState<string[]>([])
  const [statusValues, setStatusValues] = useState<string[]>([])
  const [priorityValues, setPriorityValues] = useState<string[]>([])
  const [boolValue, setBoolValue] = useState<'true' | 'false'>('true')

  // A filter is only applicable once its chosen dimension has a concrete
  // value. Multi-value dimensions (tag/status/priority) need at least one
  // selection — an empty array would build a match-everything no-op filter
  // with a broken pill label ('Tag: 0' / 'Status: '). Boolean dimensions and
  // `excludeTemplates` always carry a valid value, so they're applicable as
  // soon as the dimension is picked (#2260).
  const canApply = useMemo(() => {
    switch (dimension) {
      case '': {
        return false
      }
      case 'tag': {
        return tagIds.length > 0
      }
      case 'status': {
        return statusValues.length > 0
      }
      case 'priority': {
        return priorityValues.length > 0
      }
      default: {
        return true
      }
    }
  }, [dimension, tagIds, statusValues, priorityValues])

  const handleSubmit = useCallback(
    (e: React.SubmitEvent<HTMLFormElement>) => {
      e.preventDefault()
      if (!canApply) return
      if (!dimension) return
      let filter: GraphFilter
      switch (dimension) {
        case 'tag': {
          filter = { type: 'tag', tagIds }
          break
        }
        case 'status': {
          filter = { type: 'status', values: statusValues }
          break
        }
        case 'priority': {
          filter = { type: 'priority', values: priorityValues }
          break
        }
        case 'hasDueDate': {
          filter = { type: 'hasDueDate', value: boolValue === 'true' }
          break
        }
        case 'hasScheduledDate': {
          filter = { type: 'hasScheduledDate', value: boolValue === 'true' }
          break
        }
        case 'hasBacklinks': {
          filter = { type: 'hasBacklinks', value: boolValue === 'true' }
          break
        }
        case 'excludeTemplates': {
          filter = { type: 'excludeTemplates', value: true }
          break
        }
      }
      onApply(filter)
    },
    [canApply, dimension, tagIds, statusValues, priorityValues, boolValue, onApply],
  )

  const toggleMultiValue = useCallback(
    (current: string[], value: string): string[] =>
      current.includes(value) ? current.filter((v) => v !== value) : [...current, value],
    [],
  )

  // Dimensions already in use should be hidden from the "add" selector so the
  // user can't stack duplicates (replacement would be confusing).
  const usedTypes = useMemo(() => new Set(existingFilters.map((f) => f.type)), [existingFilters])

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- form-level onKeyDown intercepts Escape to cancel; belongs on the form container, not a child control
    <form
      className="flex flex-col gap-2"
      aria-label={t('graph.filter.addFilter')}
      onSubmit={handleSubmit}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel()
      }}
    >
      <Select
        value={dimension || '__none__'}
        onValueChange={(val) => setDimension(val === '__none__' ? '' : (val as GraphFilterType))}
      >
        <SelectTrigger size="sm" aria-label={t('graph.filter.selectDimension')}>
          <SelectValue placeholder={t('graph.filter.selectDimension')} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">{t('graph.filter.selectDimension')}</SelectItem>
          {!usedTypes.has('tag') && <SelectItem value="tag">{t('graph.filter.tag')}</SelectItem>}
          {!usedTypes.has('status') && (
            <SelectItem value="status">{t('graph.filter.status')}</SelectItem>
          )}
          {!usedTypes.has('priority') && (
            <SelectItem value="priority">{t('graph.filter.priority')}</SelectItem>
          )}
          {!usedTypes.has('hasDueDate') && (
            <SelectItem value="hasDueDate">{t('graph.filter.hasDueDate')}</SelectItem>
          )}
          {!usedTypes.has('hasScheduledDate') && (
            <SelectItem value="hasScheduledDate">{t('graph.filter.hasScheduledDate')}</SelectItem>
          )}
          {!usedTypes.has('hasBacklinks') && (
            <SelectItem value="hasBacklinks">{t('graph.filter.hasBacklinks')}</SelectItem>
          )}
          {!usedTypes.has('excludeTemplates') && (
            <SelectItem value="excludeTemplates">{t('graph.filter.excludeTemplates')}</SelectItem>
          )}
        </SelectContent>
      </Select>

      {dimension === 'tag' && (
        <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
          <legend className="sr-only">{t('graph.filter.tagPlural')}</legend>
          {allTags.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('graph.filter.tagNoTags')}</p>
          ) : (
            // Replace bare `overflow-y-auto` with the shared ScrollArea
            // primitive (AGENTS.md mandates ScrollArea for every scrollable
            // container — see `SourcePageFilter` for the reference pattern).
            <ScrollArea className="max-h-40">
              <div className="flex flex-col gap-1">
                {allTags.map((tag) => (
                  <label
                    key={tag.tag_id}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
                  >
                    {/*
                     * The visible <span> is the single source of truth
                     * for the checkbox's accessible name. We wire it up with
                     * `aria-labelledby` (not `aria-label`) so the name stays in
                     * one place — see the matching test in GraphFilterBar.test.
                     */}
                    <input
                      type="checkbox"
                      aria-labelledby={`graph-tag-${tag.tag_id}`}
                      checked={tagIds.includes(tag.tag_id)}
                      onChange={() => setTagIds((c) => toggleMultiValue(c, tag.tag_id))}
                    />
                    <span id={`graph-tag-${tag.tag_id}`}>{tag.name}</span>
                  </label>
                ))}
              </div>
            </ScrollArea>
          )}
        </fieldset>
      )}

      {dimension === 'status' && (
        <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
          <legend className="sr-only">{t('graph.filter.status')}</legend>
          <div className="flex flex-col gap-1">
            {GRAPH_STATUS_VALUES.map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={statusValues.includes(v)}
                  onChange={() => setStatusValues((c) => toggleMultiValue(c, v))}
                  aria-label={t(`graph.filter.statusValue.${v}`)}
                />
                <span>{t(`graph.filter.statusValue.${v}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {dimension === 'priority' && (
        <fieldset className="flex flex-col gap-1 border-0 p-0 m-0">
          <legend className="sr-only">{t('graph.filter.priority')}</legend>
          <div className="flex flex-col gap-1">
            {priorityLevels.map((v) => (
              <label
                key={v}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={priorityValues.includes(v)}
                  onChange={() => setPriorityValues((c) => toggleMultiValue(c, v))}
                  aria-label={t(`graph.filter.priorityValue.${v}`)}
                />
                <span>{t(`graph.filter.priorityValue.${v}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {(dimension === 'hasDueDate' ||
        dimension === 'hasScheduledDate' ||
        dimension === 'hasBacklinks') && (
        <Select value={boolValue} onValueChange={(val) => setBoolValue(val as 'true' | 'false')}>
          <SelectTrigger
            size="sm"
            aria-label={t(`graph.filter.${dimension}` as `graph.filter.${GraphFilterType}`)}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">{t('graph.filter.yes')}</SelectItem>
            <SelectItem value="false">{t('graph.filter.no')}</SelectItem>
          </SelectContent>
        </Select>
      )}

      {dimension === 'excludeTemplates' && (
        <p className="text-xs text-muted-foreground">{t('graph.filter.excludeTemplates')}</p>
      )}

      <div className="flex items-center justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onCancel}
          aria-label={t('graph.filter.cancel')}
        >
          {t('graph.filter.cancel')}
        </Button>
        <Button
          type="submit"
          variant="default"
          size="xs"
          disabled={!canApply}
          aria-label={t('graph.filter.apply')}
        >
          {t('graph.filter.apply')}
        </Button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function GraphFilterBar({
  filters,
  onFiltersChange,
  allTags,
  totalCount,
  filteredCount,
  edgesShown,
  edgesTotal,
  edgesTruncated,
}: GraphFilterBarProps): React.ReactElement {
  const { t } = useTranslation()
  const [popoverOpen, setPopoverOpen] = useState(false)

  // Hydrate persisted filters once on mount, then write to
  // localStorage whenever the controlled `filters` prop changes. The write
  // effect skips its very first run so it doesn't clobber the just-loaded
  // persisted value with the parent's pre-hydration default (empty) state
  // before the hydration dispatch has propagated through the parent.
  const hasHydratedRef = useRef(false)
  useEffect(() => {
    const persisted = readPersistedFilters()
    if (persisted !== null && persisted.length > 0) {
      onFiltersChange(persisted)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-only hydration; onFiltersChange is intentionally excluded so the effect does not re-run when the parent recreates the callback
  }, [])

  useEffect(() => {
    if (!hasHydratedRef.current) {
      // Skip the initial commit; the next change to `filters` (whether from
      // hydration above or a user action) will be persisted normally.
      hasHydratedRef.current = true
      return
    }
    writePersistedFilters(filters)
  }, [filters])

  const handleAdd = useCallback(
    (filter: GraphFilter) => {
      // Replace existing filter of the same type (prevents duplicate pills).
      const key = getGraphFilterKey(filter)
      const withoutSameType = filters.filter((f) => f.type !== filter.type)
      const isExact = filters.some((f) => getGraphFilterKey(f) === key)
      if (isExact) {
        setPopoverOpen(false)
        return
      }
      onFiltersChange([...withoutSameType, filter])
      setPopoverOpen(false)
    },
    [filters, onFiltersChange],
  )

  const handleRemove = useCallback(
    (index: number) => {
      onFiltersChange(filters.filter((_, i) => i !== index))
    },
    [filters, onFiltersChange],
  )

  const handleClearAll = useCallback(() => {
    onFiltersChange([])
  }, [onFiltersChange])

  const hasFilters = filters.length > 0
  const showingCount =
    typeof totalCount === 'number' &&
    typeof filteredCount === 'number' &&
    hasFilters &&
    totalCount !== filteredCount
  // #2298 — the backend edge cap fired: surface a non-blocking "showing
  // N of M links" notice so a partial graph is never rendered silently.
  const showEdgesTruncated =
    edgesTruncated === true && typeof edgesShown === 'number' && typeof edgesTotal === 'number'

  return (
    <fieldset
      className="graph-filter-bar flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background/80 p-2 backdrop-blur-sm"
      aria-label={t('graph.filter.addFilter')}
      data-testid="graph-filter-bar"
    >
      <legend className="sr-only">{t('graph.filter.addFilter')}</legend>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {t('graph.filter.filtersApplied', { count: filters.length })}
      </div>

      <Filter className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      <span className="hidden sm:inline text-xs font-medium text-muted-foreground">
        {t('graph.filter.label')}
      </span>

      {filters.map((filter, i) => {
        const label = filterLabel(filter, t)
        return (
          <FilterPill
            key={`${filter.type}-${getGraphFilterKey(filter)}`}
            label={label}
            removeAriaLabel={t('graph.filter.removeFilter', { label })}
            onRemove={() => handleRemove(i)}
          />
        )
      })}

      {!hasFilters && (
        <Badge tone="outline" className="text-xs text-muted-foreground">
          {t('graph.filter.noFilters')}
        </Badge>
      )}

      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            className="h-7 gap-1 text-xs"
            aria-label={t('graph.filter.addFilter')}
            aria-expanded={popoverOpen}
          >
            <Plus className="h-3 w-3" aria-hidden="true" />
            {t('graph.filter.addFilter')}
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="w-72 max-w-[calc(100vw-2rem)] p-3"
          align="start"
          aria-label={t('graph.filter.addFilterPopoverLabel')}
        >
          <AddFilterForm
            allTags={allTags}
            existingFilters={filters}
            onApply={handleAdd}
            onCancel={() => setPopoverOpen(false)}
          />
        </PopoverContent>
      </Popover>

      {hasFilters && (
        <Button
          variant="ghost"
          size="xs"
          className="h-7 text-xs"
          onClick={handleClearAll}
          aria-label={t('graph.filter.clearAll')}
        >
          <X className="h-3 w-3" aria-hidden="true" />
          {t('graph.filter.clearAll')}
        </Button>
      )}

      {showingCount && (
        <span
          className="ml-auto text-xs text-muted-foreground"
          aria-live="polite"
          aria-atomic="true"
          data-testid="graph-filter-count"
        >
          {t('graph.filter.showingCount', { filtered: filteredCount, total: totalCount })}
        </span>
      )}

      {showEdgesTruncated && (
        <span
          className={cn(
            'text-xs text-muted-foreground italic',
            // Right-align the notice when it is the only trailing item;
            // when the "showing N of M pages" count is present it owns the
            // `ml-auto` and this notice trails it.
            !showingCount && 'ml-auto',
          )}
          aria-live="polite"
          aria-atomic="true"
          data-testid="graph-edges-truncated"
        >
          {t('graph.filter.edgesTruncated', { shown: edgesShown, total: edgesTotal })}{' '}
          {/* #3314 finding 3 — the same edge cap that truncates the edge
              list also makes per-node backlink counts (and the "Has
              backlinks" filter) unreliable; say so in the same notice
              rather than letting the dimension silently misbehave. */}
          {t('graph.filter.backlinksUnavailableTruncated')}
        </span>
      )}
    </fieldset>
  )
}
