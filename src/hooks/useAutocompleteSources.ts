/**
 * Phase 2 — Resolve `AutocompleteItem[]` for the caret-anchored
 * autocomplete popover.
 *
 * Composes static value lists (state / priority / due / scheduled) with
 * dynamic sources (tag names via IPC, path-history MRU, property keys
 * cached for the session). The hook is the single source of truth for
 * "what should the popover show right now"; the orchestrator
 * (`SearchPanel`) only owns popover open-state and item-selection
 * wiring.
 */

import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { AutocompleteItem } from '@/components/search/AutocompletePopover'
import { useFailedOnce } from '@/hooks/useFailedOnce'
import { useGenerationGuard } from '@/hooks/useGenerationGuard'
import { usePriorityLevels } from '@/hooks/usePriorityLevels'
import { isCancellation } from '@/lib/app-error'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { getPathHistory } from '@/lib/path-history'
import {
  ensurePropertyKeysInvalidationListener,
  propertyKeysQueryFn,
  propertyKeysQueryKey,
  PROPERTY_KEYS_GLOBAL_KEY,
} from '@/lib/property-keys-cache'
import {
  ensurePropertyValuesInvalidationListener,
  PROPERTY_VALUES_EMPTY,
  propertyValuesQueryFn,
  propertyValuesQueryKey,
} from '@/lib/property-values-cache'
import { queryClient } from '@/lib/query-client'
import type { AutocompleteAnchor } from '@/lib/search-query/autocomplete'
import { getPropertyDef, listTagsByPrefix, paginationLimit } from '@/lib/tauri'

export const STATE_VALUES = ['TODO', 'DOING', 'DONE', 'CANCELLED', 'none'] as const
export const DATE_BUCKET_VALUES = [
  'today',
  'yesterday',
  'overdue',
  'this-week',
  'this-month',
  'next-week',
  'older',
  'none',
] as const

const TAG_DEBOUNCE_MS = 150
const TAG_LIMIT = 20

/** Stable empty-array reference for the propKey list before it resolves. */
const EMPTY: string[] = []

export interface UseAutocompleteSourcesArgs {
  anchor: AutocompleteAnchor
  spaceId: string | null
}

export interface UseAutocompleteSourcesResult {
  items: AutocompleteItem[]
  loading: boolean
}

function projectStatic(values: readonly string[], query: string): AutocompleteItem[] {
  const lowered = query.toLowerCase()
  return values.filter((v) => v.toLowerCase().startsWith(lowered)).map((v) => ({ value: v }))
}

/**
 * #1425 — merge the `select` definition's options (preferred, so the canonical
 * vocabulary leads) with the live usage-ranked values, de-duplicated, then
 * prefix-filter by the typed query. Select options come first; usage-ranked
 * values follow in backend order.
 */
function mergePropValueSuggestions(
  options: string[],
  values: string[],
  query: string,
): AutocompleteItem[] {
  const merged: string[] = []
  const seen = new Set<string>()
  for (const v of [...options, ...values]) {
    if (seen.has(v)) continue
    seen.add(v)
    merged.push(v)
  }
  const lowered = query.toLowerCase()
  return merged.filter((v) => v.toLowerCase().startsWith(lowered)).map((v) => ({ value: v }))
}

export function useAutocompleteSources(
  args: UseAutocompleteSourcesArgs,
): UseAutocompleteSourcesResult {
  const { anchor, spaceId } = args

  const active = anchor?.active ?? null
  const query = anchor?.query ?? ''

  // Tag IPC state — kept separate from synchronous projections so the
  // popover can stay open with stale items while a new request flies.
  const [tagItems, setTagItems] = useState<AutocompleteItem[]>([])
  const [tagLoading, setTagLoading] = useState(false)

  // Property-key list comes from the shared TanStack query: space-keyed,
  // in-flight-dedup, invalidated on `block:properties-changed`. The query is
  // enabled only while the propKey anchor is active, but another consumer
  // (picker, backlink filter) may have already primed the cache, in which
  // case the popover gets results instantly. The explicit `queryClient` arg
  // keeps the hook independent of a `QueryClientProvider` ancestor.
  const spaceKey = spaceId ?? PROPERTY_KEYS_GLOBAL_KEY
  const { data: propKeysData } = useQuery(
    {
      queryKey: propertyKeysQueryKey(spaceKey),
      queryFn: propertyKeysQueryFn,
      enabled: active === 'propKey',
    },
    queryClient,
  )
  const propKeys = propKeysData ?? EMPTY

  // #1425 — property-VALUE suggestions for the value side of
  // `prop:key=value`. The candidate list is the union of (a) the live
  // usage-ranked `value_text` values from the backend (key-scoped query,
  // invalidated on `block:properties-changed`) and (b) for a `select`-typed
  // definition, the definition's configured options. The select options
  // are *preferred*: they lead the list so the canonical vocabulary surfaces
  // first even before any block has recorded that value yet.
  const propValueKey = anchor?.active === 'propValue' ? anchor.key : null
  // A single derived key (empty string when no propValue anchor) keeps the
  // query-key + queryFn in sync and the `enabled` gate to one truthiness check.
  const propValuesKey = propValueKey ?? ''
  const { data: propValuesData } = useQuery(
    {
      queryKey: propertyValuesQueryKey(propValuesKey),
      queryFn: () => propertyValuesQueryFn(propValuesKey),
      enabled: propValuesKey !== '',
    },
    queryClient,
  )
  const propValues = propValuesData ?? PROPERTY_VALUES_EMPTY
  // Select-definition options keyed by property key. Fetched once per key
  // on first propValue activation; a `null` entry records "fetched, not a
  // select / no options" so we don't refetch.
  const [selectOptions, setSelectOptions] = useState<Record<string, string[] | null>>({})
  // #1634 — mirror `selectOptions` into a ref so the lazy-fetch effect can
  // read the "already resolved for this key?" guard WITHOUT listing
  // `selectOptions` in its deps. Otherwise any key's resolution changes the
  // object identity and needlessly re-runs the effect for the active key,
  // re-firing the idempotent value-fetch each time.
  const selectOptionsRef = useRef(selectOptions)
  selectOptionsRef.current = selectOptions

  // Phase 4.M3 — shared race-discard hook. The guard bumps on
  // every tag-anchor activation AND on every keystroke while active;
  // stale resolutions check it before writing state. Leaving the
  // `tag` anchor entirely also bumps the guard so an in-flight
  // resolution can't strand stale items for a later return-to-tag.
  const tagGen = useGenerationGuard()
  // Phase 3.U1 — once-per-session failure surface.
  const surfaceFailureOnce = useFailedOnce()
  const { t } = useTranslation()
  const tagDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // DOC-A7 follow-up — priority autocomplete values must track the
  // user-configurable priority levels (the source of truth), NOT a stale
  // hardcoded `A/B/C`. The filter parser + chips use the numeric
  // `DEFAULT_PRIORITY_LEVELS` (`1`/`2`/`3`), so suggesting `A/B/C` offered
  // values that never matched. `none` is appended to mirror the cycle.
  const priorityLevels = usePriorityLevels()
  const priorityValues = useMemo(() => [...priorityLevels, 'none'], [priorityLevels])

  // ── PropKey invalidation wiring ───────────────────────────────────
  // The fetch itself is driven by the `useQuery` above (enabled while the
  // propKey anchor is active); this effect only registers the event →
  // invalidate listener so a `block:properties-changed` write refreshes the
  // key list. Idempotent and process-lifetime.
  useEffect(() => {
    if (active !== 'propKey') return
    ensurePropertyKeysInvalidationListener()
  }, [active])

  // ── PropValue lazy resolve (#1425) ────────────────────────────────
  // On propValue activation: (1) register the values invalidation listener
  // (the fetch is driven by the `useQuery` above), and (2) one-shot resolve
  // the key's definition so a `select` type can seed its options. Keyed on
  // `propValueKey`, so switching keys re-resolves cleanly.
  useEffect(() => {
    if (active !== 'propValue' || propValueKey == null || propValueKey === '') return
    ensurePropertyValuesInvalidationListener()
    // Resolve the definition once per key. `undefined` in the map means
    // "not yet fetched"; we record `string[]` for select options or `null`
    // otherwise so the fetch never repeats for the same key.
    if (selectOptionsRef.current[propValueKey] === undefined) {
      let cancelled = false
      getPropertyDef(propValueKey)
        .then((def) => {
          if (cancelled) return
          let opts: string[] | null = null
          if (def?.value_type === 'select' && def.options != null) {
            try {
              const parsed: unknown = JSON.parse(def.options)
              if (Array.isArray(parsed)) {
                opts = parsed.filter((o): o is string => typeof o === 'string')
              }
            } catch {
              opts = null
            }
          }
          setSelectOptions((prev) => ({ ...prev, [propValueKey]: opts }))
        })
        .catch(() => {
          if (cancelled) return
          setSelectOptions((prev) => ({ ...prev, [propValueKey]: null }))
        })
      return () => {
        cancelled = true
      }
    }
    return undefined
  }, [active, propValueKey])

  // ── Tag IPC (debounced, stale-while-loading) ──────────────────────
  useEffect(() => {
    if (active !== 'tag') {
      // Bump the guard so any in-flight tag promise that resolves
      // later can't strand stale items for a future return-to-tag.
      tagGen.next()
      if (tagDebounceTimerRef.current) {
        clearTimeout(tagDebounceTimerRef.current)
        tagDebounceTimerRef.current = null
      }
      setTagLoading(false)
      return
    }

    if (tagDebounceTimerRef.current) clearTimeout(tagDebounceTimerRef.current)
    const requestId = tagGen.next()
    setTagLoading(true)
    tagDebounceTimerRef.current = setTimeout(() => {
      tagDebounceTimerRef.current = null
      listTagsByPrefix({ prefix: query, limit: paginationLimit(TAG_LIMIT) })
        .then((rows) => {
          if (!tagGen.isCurrent(requestId)) return
          setTagItems(rows.map((row) => ({ value: row.name })))
          setTagLoading(false)
        })
        .catch((err: unknown) => {
          if (!tagGen.isCurrent(requestId)) return
          // Phase 2 — see CommandPalette.tsx for the cancellation rationale.
          if (isCancellation(err)) return
          logger.warn('useAutocompleteSources', 'listTagsByPrefix failed', { prefix: query }, err)
          // Phase 3.U1 — once-per-session toast for real failures.
          surfaceFailureOnce('autocomplete:tags', () => notify.error(t('search.failed')))
          setTagLoading(false)
        })
    }, TAG_DEBOUNCE_MS)

    return () => {
      if (tagDebounceTimerRef.current) {
        clearTimeout(tagDebounceTimerRef.current)
        tagDebounceTimerRef.current = null
      }
    }
  }, [active, query, tagGen, surfaceFailureOnce, t])

  if (anchor == null) {
    return { items: [], loading: false }
  }

  switch (anchor.active) {
    // #1682 — negated kinds (`notState`/`notPriority`) share the positive
    // value vocabulary; they carry a distinct anchor kind only so the
    // negation signal is preserved should negated-chip UX ever diverge.
    case 'state':
    case 'notState': {
      return { items: projectStatic(STATE_VALUES, anchor.query), loading: false }
    }
    case 'priority':
    case 'notPriority': {
      return { items: projectStatic(priorityValues, anchor.query), loading: false }
    }
    case 'due':
    case 'scheduled': {
      return { items: projectStatic(DATE_BUCKET_VALUES, anchor.query), loading: false }
    }
    case 'pathInclude':
    case 'pathExclude': {
      const history = getPathHistory(spaceId)
      return { items: projectStatic(history, anchor.query), loading: false }
    }
    case 'tag': {
      return { items: tagItems, loading: tagLoading }
    }
    case 'propKey': {
      // `usePropertyKeysCache` returns the stable empty array until the
      // first fetch resolves; `loading: false` because the cache is
      // shared with the rest of the app and we don't own its lifecycle.
      return { items: projectStatic(propKeys, anchor.query), loading: false }
    }
    case 'propValue': {
      // Select options (preferred) merged with usage-ranked values, deduped and
      // prefix-filtered — see `mergePropValueSuggestions`.
      const opts = (propValueKey != null ? selectOptions[propValueKey] : null) ?? []
      return {
        items: mergePropValueSuggestions(opts, propValues, anchor.query),
        loading: false,
      }
    }
    default: {
      return { items: [], loading: false }
    }
  }
}
