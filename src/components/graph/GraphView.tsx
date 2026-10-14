/**
 * GraphView — force-directed graph of page relationships (F-33).
 *
 * Nodes = pages, edges = [[links]] between pages.
 *
 * Force simulation runs in a WebWorker with a main-thread
 * fallback. If the worker fails at runtime (module-resolution error,
 * CSP block, runtime throw) the component transparently falls back to
 * The main-thread path — see `useGraphSimulation` (+).
 *
 * Data fetching lives in `GraphView.helpers.ts::fetchGraphData`
 *. SVG rendering, zoom, and drag are owned by the hook.
 */

import { AlertCircle, Maximize2, Minus, Network, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { FeatureErrorBoundary } from '@/components/common/FeatureErrorBoundary'
import { GraphFilterBar } from '@/components/graph/GraphFilterBar'
import {
  fetchGraphData,
  type GraphEdge,
  type GraphNode,
} from '@/components/graph/GraphView.helpers'
import { LocalGraphControl } from '@/components/graph/LocalGraphControl'
import { LoadingSkeleton } from '@/components/rendering/LoadingSkeleton'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import {
  type GraphLayoutStore,
  type GraphPageActions,
  useGraphSimulation,
} from '@/hooks/useGraphSimulation'
import { useGraphStructureEvents } from '@/hooks/useGraphStructureEvents'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useShouldShowMobileChrome } from '@/hooks/useShouldShowMobileChrome'
import { announce } from '@/lib/announcer'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { applyGraphFilters, type GraphFilter } from '@/lib/graph-filters'
import { computeLocalGraph, type LocalGraphHops } from '@/lib/graph-neighborhood'
import type { GraphLayout } from '@/lib/graph-sim-helpers'
import { getShortcutKeys } from '@/lib/keyboard-config'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { requireActiveScope } from '@/lib/space-scope'
import { cn } from '@/lib/utils'
import { useSpaceStore } from '@/stores/space'
import { selectPageStack, useTabsStore } from '@/stores/tabs'

// ── Module-level cache for stale-while-revalidate ────────────
const GRAPH_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export interface GraphCache {
  nodes: GraphNode[]
  edges: GraphEdge[]
  timestamp: number
  // #1818 / #1530: the combined mutation counter at the time this entry was
  // fetched. It folds two module-level signals: the block-PROPERTY counter
  // (#1818, `block:properties-changed`) and the graph-STRUCTURE counter (#1530,
  // bumped on local block/link/page CRUD via `page-blocks.ts` and on
  // `sync:complete`). The structure counter is the one that actually tracks the
  // graph's axis (nodes = pages, edges = `[[links]]`): page creation, a text
  // edit that adds/removes a `[[link]]`, and block insert/delete/move all bump
  // it but never fire the property event. A later mount compares this against
  // the *current* combined counter: if either mutation fired since (even while
  // GraphView was unmounted), the entry is stale and must be refetched
  // regardless of TTL. Storing the key on the entry (rather than a per-instance
  // ref) is what makes invalidation survive unmount — the per-instance
  // `lastInvalidationRef` initializes to the current key on every mount, so it
  // alone can never detect a mutation that happened while no instance was
  // mounted.
  invalidationKey: number
  // #2298 count-then-cap: the TRUE matching-edge count and the cap-fired
  // flag from `PageLinksResponse`, cached alongside the (possibly capped)
  // edge set so serving a cache hit re-shows the same "showing N of M
  // links" notice the original fetch produced.
  edgesTotal: number
  edgesTruncated: boolean
}

/**
 * Maximum cached (spaceId, tagIds) entries. The map is keyed by every
 * distinct tag-filter combination the user tries, so without a bound it
 * grows for the whole session (each entry holds full node/edge arrays).
 * A handful of entries covers realistic back-and-forth filter toggling;
 * older combinations are cheap to refetch (#758 item 4).
 *
 * @internal exported for tests.
 */
export const GRAPH_CACHE_MAX_ENTRIES = 8

const graphCacheMap = new Map<string, GraphCache>()

/**
 * Per space, for this session only: a new session lays the graph out from
 * scratch (#5434).
 */
const graphLayoutMap = new Map<string, GraphLayout>()

/**
 * LRU read: refresh the entry's recency (Map preserves insertion order, so
 * delete + re-set moves it to the back of the eviction queue).
 */
function lruGet<T>(map: Map<string, T>, key: string): T | null {
  const entry = map.get(key)
  if (entry === undefined) return null
  map.delete(key)
  map.set(key, entry)
  return entry
}

/**
 * LRU write: insert as most-recent and evict the least-recently-used
 * entries beyond `GRAPH_CACHE_MAX_ENTRIES`.
 */
function lruSet<T>(map: Map<string, T>, key: string, entry: T): void {
  map.delete(key)
  map.set(key, entry)
  while (map.size > GRAPH_CACHE_MAX_ENTRIES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

/** @internal exported for tests. */
export function getGraphCacheEntry(key: string): GraphCache | null {
  return lruGet(graphCacheMap, key)
}

/** @internal exported for tests. */
export function setGraphCacheEntry(key: string, entry: GraphCache): void {
  lruSet(graphCacheMap, key, entry)
}

/** @internal exported for tests. */
export function getGraphLayoutEntry(spaceKey: string): GraphLayout | null {
  return lruGet(graphLayoutMap, spaceKey)
}

/** @internal exported for tests. */
export function setGraphLayoutEntry(spaceKey: string, layout: GraphLayout): void {
  lruSet(graphLayoutMap, spaceKey, layout)
}

/** Sentinel value for "all pages" (no tag filter). */
const TAG_ALL_KEY = '__all__'

/**
 * Cache key is derived from the sorted set of tag IDs being used for the
 * server-side fetch. Client-side filters (status, priority, has-*, etc.) do
 * not invalidate the cache — they are applied after fetch.
 */
function getCacheKey(tagIds: readonly string[]): string {
  if (tagIds.length === 0) return TAG_ALL_KEY
  return [...tagIds].toSorted().join(',')
}

/** @internal — exported for test isolation only. */
export function clearGraphCache(): void {
  graphCacheMap.clear()
  graphLayoutMap.clear()
}

/**
 * Append the current keyboard shortcut binding (if any) to a label
 * so icon-only buttons surface their hotkey via the accessible name. Returns
 * the bare label when no binding is configured to avoid a stray "()".
 */
function withShortcut(label: string, shortcutId: string): string {
  const keys = getShortcutKeys(shortcutId)
  return keys ? `${label} (${keys})` : label
}

// Stable reference for the "no tag filter" case so the fetch effect's
// `tagFilterIds` dependency doesn't change identity on every unrelated
// (client-side) filter toggle and re-fire the graph fetch.
const EMPTY_TAG_IDS: string[] = []

export function GraphView(): React.ReactElement {
  const { t } = useTranslation()
  // #1530: combine TWO module-level mutation signals into one effective
  // invalidation key. The block-PROPERTY counter (#1818) fires only on property
  // commands; the graph-STRUCTURE counter (#1530) fires on the mutations that
  // actually change the page-link graph — local block/link/page CRUD (via
  // `page-blocks.ts`) and applied remote ops (`sync:complete`). Summing them
  // keeps the existing property-driven invalidation as a backstop while adding
  // the correct structure axis; either bump advances the combined key, so the
  // downstream `mutated` / `cacheStaleByMutation` machinery refetches on either.
  const { invalidationKey: propertyKey } = useBlockPropertyEvents()
  const { structureKey } = useGraphStructureEvents()
  const invalidationKey = propertyKey + structureKey
  const navigateToPage = useTabsStore((s) => s.navigateToPage)
  const openInNewTab = useTabsStore((s) => s.openInNewTab)
  // The tab bar is desktop-only, so on mobile a new tab would open out of sight.
  const isMobile = useIsMobile()
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const svgRef = useRef<SVGSVGElement>(null)
  // #1530: remember the last combined `invalidationKey` applied to a fetch so a
  // graph-structure mutation (page/`[[link]]` create, block edit/insert/delete/
  // move) — or a property change — can force a stale-while-revalidate refetch
  // (bypass the fresh-cache early-exit) without changing the cache key, TTL, or
  // eviction.
  const lastInvalidationRef = useRef(invalidationKey)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // #3315 item 4 — the error branch rendered an `EmptyState` with no `action`,
  // and it early-returns ABOVE the branch that mounts GraphFilterBar /
  // LocalGraphControl, so a failed fetch left the user with no on-screen
  // control able to re-trigger it: recovery depended on an unrelated CRUD op or
  // an applied sync batch bumping `invalidationKey`, or on navigating away and
  // back — neither discoverable. This nonce is a dependency of the fetch effect
  // AND bypasses the fresh-cache early-exit, so Retry always re-runs the
  // fan-out. Every sibling surface (SearchPanel, AdvancedQueryView,
  // QueryResult, SavedViews, HistoryView, DeviceManagement) already has one.
  const [retryNonce, setRetryNonce] = useState(0)
  const lastRetryRef = useRef(0)
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  // #2298 — true edge count + cap-fired flag from the latest fetch (or the
  // cache entry being served); drives the "showing N of M links" notice.
  const [edgesTotal, setEdgesTotal] = useState(0)
  const [edgesTruncated, setEdgesTruncated] = useState(false)
  const [tags, setTags] = useState<Array<{ tag_id: string; name: string }>>([])
  // What a space with no stored graph filters shows (#5370); `GraphFilterBar`
  // replaces it with the stored list, even an empty one.
  const [filters, setFilters] = useState<GraphFilter[]>([{ type: 'excludeJournal', value: true }])

  // Local-graph mode (#1429): when active, the graph is filtered to the
  // `localHops`-neighborhood of the page open in the active tab. Mode and depth
  // persist per space (#5433), so the graph reopens as it was left; before a
  // space is known there is nothing to read or keep.
  const [storedLocal] = useState(() =>
    currentSpaceId == null
      ? PREFERENCES.graphLocal.defaultValue
      : readPreference(PREFERENCES.graphLocal, currentSpaceId),
  )
  const [localMode, setLocalMode] = useState(storedLocal.active)
  const [localHops, setLocalHops] = useState<LocalGraphHops>(storedLocal.hops)

  // The "current page" = the top of the active tab's page stack. `null` when
  // the active tab has no page open (e.g. a view tab), which disables the
  // focus toggle. Its node carries the graph's one accent (#5429).
  const pageStack = useTabsStore(selectPageStack)
  const seedEntry = pageStack.length > 0 ? pageStack.at(-1) : null
  const seedPageId = seedEntry?.pageId ?? null

  // A click or Space selects a node; in local mode the graph re-centres on it.
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const pageActions = useMemo<GraphPageActions>(
    () => ({
      select: (id, label) => {
        setSelectedPageId(id)
        announce(t('graph.selected', { page: label }))
      },
      open: navigateToPage,
      openInNewTab: isMobile ? navigateToPage : openInNewTab,
    }),
    [t, navigateToPage, openInNewTab, isMobile],
  )

  // Extract the tag filter's tagIds — these drive server-side fetching.
  // Every other filter is applied client-side via `applyGraphFilters`.
  const tagFilterIds = useMemo((): string[] => {
    const tagFilter = filters.find((f) => f.type === 'tag')
    return tagFilter && tagFilter.type === 'tag' ? tagFilter.tagIds : EMPTY_TAG_IDS
  }, [filters])

  // Stable-ish key to trigger refetch when the tag set or active space
  // changes — the cache is keyed by (spaceId, tagIds) so switching
  // spaces doesn't show the wrong space's nodes from cache.
  const spaceKey = currentSpaceId ?? '__null__'
  const tagCacheKey = useMemo(
    () => `${spaceKey}|${getCacheKey(tagFilterIds)}`,
    [spaceKey, tagFilterIds],
  )
  const layout = useMemo<GraphLayoutStore>(
    () => ({
      read: () => getGraphLayoutEntry(spaceKey),
      keep: (kept) => setGraphLayoutEntry(spaceKey, kept),
    }),
    [spaceKey],
  )

  // Fetch the active space's tags, again on every space switch. The filter
  // bar has no search, so it needs every tag, not a capped prefix page.
  useEffect(() => {
    if (currentSpaceId == null) return
    let cancelled = false
    commands
      .listAllTagsInSpace(requireActiveScope(currentSpaceId))
      .then(unwrap)
      .then((result) => {
        if (!cancelled) setTags(result ?? [])
      })
      .catch((err) => {
        if (cancelled) return
        logger.error('GraphView', 'Failed to load tags', undefined, err)
        // #2545: don't fail silently. A logger-only catch left the tag-filter
        // dropdown empty with zero user feedback (the user concludes they have
        // no tags). Surface it like the main graph fetch does, deduped by id
        // so a remount can't stack duplicate toasts.
        notify.error(t('graph.tagsLoadFailed'), { id: 'graph-tags' })
      })
    return () => {
      cancelled = true
    }
  }, [currentSpaceId, t])

  // Fetch data with stale-while-revalidate caching
  useEffect(() => {
    let cancelled = false

    // Clear any stale error from a prior failed load: the `if (error)`
    // render guard sits before the populated-graph branch, so without this
    // a successful refetch (tag/space change) would stay masked by the old
    // "failed to load" screen until a full remount.
    // oxlint-disable-next-line react/set-state-in-effect -- clears the previous fetch's failure as this effect starts a new graph load, so a successful refetch is not masked by the stale error; see #4407
    setError(null)

    const graphCache = getGraphCacheEntry(tagCacheKey)

    // #1530: a graph-structure mutation (e.g. creating a page or a [[link]], or
    // an applied remote sync batch) — or a block-property change — bumps the
    // combined `invalidationKey`. When it changed since the last fetch, force a
    // refetch — but keep serving the cached nodes/edges immediately
    // (stale-while-revalidate). Record the new value so subsequent renders
    // for the same mutation don't keep bypassing the freshness guard.
    const mutated = invalidationKey !== lastInvalidationRef.current
    lastInvalidationRef.current = invalidationKey

    // #3315 item 4: an explicit Retry must bypass the fresh-cache early-exit
    // below, exactly as a mutation does — otherwise the button would be a no-op
    // whenever a stale-but-fresh-enough cache entry exists for this tag key.
    const retried = retryNonce !== lastRetryRef.current
    lastRetryRef.current = retryNonce

    // Serve cached data immediately if available
    if (graphCache) {
      setNodes(graphCache.nodes)
      setEdges(graphCache.edges)
      setEdgesTotal(graphCache.edgesTotal)
      setEdgesTruncated(graphCache.edgesTruncated)
      setLoading(false)

      // #1818: the cache entry also records the invalidation counter it was
      // fetched at. If a mutation fired since then — including while this
      // GraphView was unmounted, which the per-instance `mutated` flag above
      // CANNOT detect because `lastInvalidationRef` re-initializes to the
      // current key on each mount — the entry is stale even within the TTL.
      const cacheStaleByMutation = graphCache.invalidationKey !== invalidationKey

      // If cache is still fresh, no mutation fired for this instance, and the
      // entry wasn't invalidated by a mutation during unmount, skip the refetch.
      if (
        !mutated &&
        !retried &&
        !cacheStaleByMutation &&
        Date.now() - graphCache.timestamp < GRAPH_CACHE_TTL_MS
      )
        return
    }

    async function run() {
      try {
        const result = await fetchGraphData(tagFilterIds, currentSpaceId)
        if (cancelled) return

        setGraphCacheEntry(tagCacheKey, {
          nodes: result.nodes,
          edges: result.edges,
          timestamp: Date.now(),
          // #1818: stamp the entry with the invalidation counter it was fetched
          // at so a later mount can detect a mutation that occurred since (incl.
          // during unmount) and refetch even within the TTL.
          invalidationKey,
          edgesTotal: result.edgesTotal,
          edgesTruncated: result.edgesTruncated,
        })

        setNodes(result.nodes)
        setEdges(result.edges)
        setEdgesTotal(result.edgesTotal)
        setEdgesTruncated(result.edgesTruncated)
      } catch (err) {
        if (cancelled) return
        logger.error('GraphView', 'failed to load graph data', undefined, err)
        setError(t('graph.loadFailed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void run()
    return () => {
      cancelled = true
    }
    // #1530: the combined `invalidationKey` (property + structure counters) is a
    // real dependency — the `mutated` check above reads it to bypass the
    // fresh-cache early-exit so graph-structure mutations (and property changes)
    // refetch the graph (stale-while-revalidate).
  }, [t, tagCacheKey, tagFilterIds, currentSpaceId, invalidationKey, retryNonce])

  // #3315 item 4 — re-run the fetch effect from the error EmptyState's action
  // slot. `setLoading(true)` swaps the error screen for the skeleton
  // immediately so the click has visible feedback even on a slow fan-out; the
  // effect clears `error` itself on entry.
  const handleRetry = useCallback(() => {
    setLoading(true)
    setRetryNonce((n) => n + 1)
  }, [])

  const localActive = localMode && seedPageId !== null
  // `null` outside local mode, so a selection there does not re-filter and reheat the layout.
  const localSeedId = localActive ? (selectedPageId ?? seedPageId) : null

  // Client-side filtering (status, priority, has-date, has-backlinks, exclude-templates).
  // Tag filter is pass-through here because tag_ids is not populated on nodes
  // — the tag dimension is enforced by the server-side fetch above. A journal
  // page open in a tab still seeds local mode: the default journal filter would
  // drop the seed, and local mode would fall back to the whole graph (#5370).
  const filteredNodes = useMemo(() => {
    const kept = applyGraphFilters(nodes, filters)
    const seed = nodes.find((n) => n.id === localSeedId)
    if (seed === undefined || kept.includes(seed)) return kept
    const seedFilters = filters.filter((f) => f.type !== 'excludeJournal')
    return applyGraphFilters([seed], seedFilters).length > 0 ? [...kept, seed] : kept
  }, [nodes, filters, localSeedId])
  const filteredEdges = useMemo(() => {
    if (filteredNodes.length === nodes.length) return edges
    const visibleIds = new Set(filteredNodes.map((n) => n.id))
    return edges.filter((e) => {
      const src = typeof e.source === 'string' ? e.source : (e.source as GraphNode).id
      const tgt = typeof e.target === 'string' ? e.target : (e.target as GraphNode).id
      return visibleIds.has(src) && visibleIds.has(tgt)
    })
  }, [edges, filteredNodes, nodes.length])

  // Local-graph layer (#1429): when focus mode is active and a page is open,
  // narrow the (already filter-applied) graph to the seed's N-hop neighborhood.
  // Reuses the same node/edge shapes so the renderer is untouched. A seed the
  // filters hide leaves nothing to show, and the overlay below says so.
  const seedLabel = useMemo(() => {
    if (seedPageId === null) return null
    return nodes.find((n) => n.id === seedPageId)?.label ?? seedEntry?.title ?? null
  }, [nodes, seedPageId, seedEntry])
  const walkedFromSeed = localSeedId !== null && localSeedId !== seedPageId
  const localSeedLabel = walkedFromSeed
    ? (nodes.find((n) => n.id === localSeedId)?.label ?? null)
    : seedLabel

  // A tag opens in the page editor too, but the graph's nodes are pages only.
  const seedIsTag = tags.some((tag) => tag.tag_id === localSeedId)

  // #1752: when the active tab loses its page (seed becomes `null`), clear
  // local-graph mode in state. Otherwise the boolean lingers as `true` —
  // visually inert while there's no seed, but silently reactivating the
  // moment a page reopens. Resetting forces a deliberate re-entry instead.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- clears local-graph mode when the active tab loses its seed page (#1752), so the flag cannot silently reactivate when a page reopens; see #4407
    if (seedPageId === null && localMode) setLocalMode(false)
  }, [seedPageId, localMode])

  // With no page open the controls are disabled and the reset above is not the
  // user's choice, so writing would erase the mode remembered for the space.
  useEffect(() => {
    if (currentSpaceId == null || seedPageId === null) return
    writePreference(PREFERENCES.graphLocal, { active: localMode, hops: localHops }, currentSpaceId)
  }, [currentSpaceId, seedPageId, localMode, localHops])

  const { displayNodes, displayEdges } = useMemo(() => {
    if (localSeedId === null) {
      return { displayNodes: filteredNodes, displayEdges: filteredEdges }
    }
    const local = computeLocalGraph(filteredNodes, filteredEdges, localSeedId, localHops)
    return { displayNodes: local.nodes, displayEdges: local.edges }
  }, [localSeedId, localHops, filteredNodes, filteredEdges])

  // d3-force simulation + worker lifecycle + zoom handlers.
  const showMobileChrome = useShouldShowMobileChrome()
  const { zoomIn, zoomOut, fitToView } = useGraphSimulation({
    svgRef,
    nodes: displayNodes,
    edges: displayEdges,
    actions: pageActions,
    currentPageId: seedPageId,
    selectedPageId,
    layout,
  })

  if (loading)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
        <LoadingSkeleton count={3} height="h-16" />
      </div>
    )
  // Render `error` via the shared EmptyState primitive instead
  // of an ad-hoc `role="alert"` card so the failure mode reuses the same
  // visual language as the empty / no-data path.
  if (error)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
        {/* #3315 item 4 — use EmptyState's existing `action` slot so the
            failure is recoverable in place, mirroring SearchPanel's
            `search-error-retry`. */}
        <EmptyState
          icon={AlertCircle}
          message={error}
          action={
            <Button
              variant="outline"
              size="sm"
              className="mt-3 mx-auto flex items-center gap-1"
              onClick={handleRetry}
              data-testid="graph-error-retry"
            >
              <RefreshCw className="h-4 w-4" />
              {t('action.retry')}
            </Button>
          }
        />
      </div>
    )
  if (nodes.length === 0)
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
        <EmptyState icon={Network} message={t('graph.noPages')} />
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-4">
      <div
        className="graph-view relative h-full w-full flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-background"
        data-testid="graph-view"
      >
        {/* Multi-dimension filter bar.
            Wrapped in FeatureErrorBoundary so a crash in the filter / cytoscape
            integration doesn't blank the entire GraphView (UX Tier 3). */}
        <div
          className="absolute top-2 left-2 right-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-start gap-1.5"
          data-testid="graph-tag-filter"
        >
          <FeatureErrorBoundary name="GraphFilterBar">
            <GraphFilterBar
              filters={filters}
              onFiltersChange={setFilters}
              allTags={tags}
              totalCount={nodes.length}
              filteredCount={filteredNodes.length}
              /* #2298 — the notice says "Showing N of M links", so N must be
                 the edge count that survives client-side dimension filtering
                 (`filteredEdges`), not the raw fetched set: with a status/
                 priority/has-* filter active, `edges.length` would overstate
                 what is on screen. Mirrors `filteredCount` above, which also
                 reports the post-filter (but pre-local-mode) count. */
              edgesShown={filteredEdges.length}
              edgesTotal={edgesTotal}
              edgesTruncated={edgesTruncated}
            />
          </FeatureErrorBoundary>
          {/* #1429 — per-page local-graph toggle + hop-depth control. */}
          <LocalGraphControl
            active={localMode}
            onToggle={setLocalMode}
            hops={localHops}
            onHopsChange={setLocalHops}
            seedLabel={seedPageId === null ? null : localSeedLabel}
            originLabel={walkedFromSeed ? seedLabel : null}
            onReturnToOrigin={() => setSelectedPageId(null)}
          />
        </div>
        {/*
         * `position: absolute; inset: 0` is required for the SVG to fill
         * the `.graph-view` (relative) container. Bare `h-full` on an inline SVG
         * does NOT resolve against a block-level flex-item parent in Chromium —
         * it falls back to the SVG's intrinsic 150 px default height, which was
         * the symptom (nodes clustered in the top 150 px of an 800 px container).
         * All other children of `.graph-view` are already absolutely positioned
         * (filter bar, truncated badge, zoom buttons); this keeps every child in
         * the same layout model and stacks via source order (SVG first → z-0,
         * overlays after → above).
         */}
        {/*
         * The nodes are the `option`s of this listbox: Space selects one and
         * Enter opens it, which a `button` could not tell apart.
         */}
        {/*
         * Pair the SVG with a visually-hidden hint so keyboard users
         * discover that nodes are activatable. `aria-describedby` points at
         * the `sr-only` paragraph so ATs read the hint alongside the SVG's
         * accessible name without affecting visual layout.
         */}
        <p id="graph-keyboard-hint" className="sr-only">
          {t('graph.keyboardHint')}
        </p>
        <svg
          ref={svgRef}
          className="absolute inset-0 h-full w-full"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- the listbox is the SVG canvas whose d3-drawn node groups are its options; a <select> cannot draw a graph
          role="listbox"
          aria-label={t('graph.title')}
          aria-describedby="graph-keyboard-hint"
          data-testid="graph-svg"
        />
        {/*
         * BUG #746: when a filter combination matches no pages, the SVG is
         * cleared and its simulation torn down by `useGraphSimulation`. The
         * SVG stays mounted (so the filter bar above remains usable to widen
         * the filter), and this overlay surfaces the empty state. Guarded on
         * `displayNodes.length === 0` rather than `nodes.length === 0` (which
         * the top-level branch above already handles) so it fires precisely
         * for the "filtered to zero" case, including a local-mode seed the
         * filters hide.
         */}
        {displayNodes.length === 0 && (
          <div
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
            data-testid="graph-no-matches"
          >
            <EmptyState
              icon={Network}
              message={
                localActive
                  ? t(seedIsTag ? 'graph.local.seedIsTag' : 'graph.local.seedHidden', {
                      page: localSeedLabel,
                    })
                  : t('graph.noMatches')
              }
            />
          </div>
        )}
        {/* Bottom-left while the mobile quick-capture FAB holds the bottom-right corner. */}
        <div
          className={cn(
            'absolute bottom-3 flex flex-col gap-1',
            showMobileChrome ? 'left-3' : 'right-3',
          )}
          data-testid="graph-zoom-controls"
        >
          <IconButton
            variant="outline"
            onClick={zoomIn}
            tooltip={t('graph.zoomIn')}
            ariaLabel={withShortcut(t('graph.zoomIn'), 'graphZoomIn')}
          >
            <Plus className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="outline"
            onClick={zoomOut}
            tooltip={t('graph.zoomOut')}
            ariaLabel={withShortcut(t('graph.zoomOut'), 'graphZoomOut')}
          >
            <Minus className="h-4 w-4" />
          </IconButton>
          <IconButton
            variant="outline"
            onClick={fitToView}
            tooltip={t('graph.zoomReset')}
            ariaLabel={withShortcut(t('graph.zoomReset'), 'graphZoomReset')}
          >
            <Maximize2 className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  )
}
