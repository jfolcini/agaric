/**
 * BlockTree — thin orchestrator composing extracted feature components.
 *
 * Delegates to:
 * - useBlockCollapse — collapse/expand state
 * - useBlockZoom — zoom navigation + breadcrumbs
 * - useBlockLinkResolve — `[[ULID]]` cache scan + batch resolve
 * - useBlockNavigateToLink — `handleNavigate` + `handleNavigateRef`
 * - useBlockFlush — editor flush + split + checkbox/todo persistence
 * - useBlockAutoCreateFirstBlock — H-9 first-block-on-empty-page effect
 * - useBlockTreeContextBags — memoised action + resolver bags
 * - useBlockDialogs — dialog state + open/close/act handlers (history,
 *   property drawer, query builder, emoji picker)
 * - useFocusedBlockActions — focused-block command handlers for the keyboard
 * - BlockZoomBar — zoom breadcrumb UI
 * - BlockListRenderer — SortableContext + block map
 * - BlockTreeDialogs — the four block-level dialog mounts
 * - BlockDnDOverlay — drag preview
 */

import {
  type Announcements,
  closestCenter,
  DndContext,
  MeasuringStrategy,
  type ScreenReaderInstructions,
} from '@dnd-kit/core'
import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'

import { BlockBatchActionMenu } from '@/components/block-tree/BlockBatchActionMenu'
import { BlockDatePicker } from '@/components/block-tree/BlockDatePicker'
import { BlockDndOverlay } from '@/components/block-tree/BlockDndOverlay'
import { TemplatePicker } from '@/components/block-tree/TemplatePicker'
import { useBlockActionOrchestration } from '@/components/block-tree/use-block-action-orchestration'
import { BlockActionsProvider } from '@/components/block-tree/use-block-actions'
import { useBlockAutoCreateFirstBlock } from '@/components/block-tree/use-block-auto-create-first-block'
import { useBlockCollapse } from '@/components/block-tree/use-block-collapse'
import { useBlockDatePicker } from '@/components/block-tree/use-block-date-picker'
import { useBlockDnD } from '@/components/block-tree/use-block-dnd'
import { useBlockFlush } from '@/components/block-tree/use-block-flush'
import { useBlockLinkResolve } from '@/components/block-tree/use-block-link-resolve'
import { useBlockMountLimit } from '@/components/block-tree/use-block-mount-limit'
import { useBlockMultiSelect } from '@/components/block-tree/use-block-multi-select'
import { useBlockNavigateToLink } from '@/components/block-tree/use-block-navigate-to-link'
import { useBlockProperties } from '@/components/block-tree/use-block-properties'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import { BlockResolversProvider } from '@/components/block-tree/use-block-resolvers'
import { useBlockSlashCommands } from '@/components/block-tree/use-block-slash-commands'
import { useBlockTreeContextBags } from '@/components/block-tree/use-block-tree-context-bags'
import { useBlockTreeEventListeners } from '@/components/block-tree/use-block-tree-event-listeners'
import { useBlockTreeKeyboardShortcuts } from '@/components/block-tree/use-block-tree-keyboard-shortcuts'
import { useBlockZoom } from '@/components/block-tree/use-block-zoom'
import { useBlockZoomEmptySeed } from '@/components/block-tree/use-block-zoom-empty-seed'
import { BlockListRenderer } from '@/components/editor/BlockListRenderer'
import { BlockTreeDialogs } from '@/components/editor/BlockTreeDialogs'
import { BlockZoomBar } from '@/components/editor/BlockZoomBar'
import { EditorSurfaceContext } from '@/components/editor/editor-surface-context'
import { useBlockDialogs } from '@/components/editor/useBlockDialogs'
import { useFocusedBlockActions } from '@/components/editor/useFocusedBlockActions'
import { Skeleton } from '@/components/ui/skeleton'
import { getActiveEditor, setActiveEditor } from '@/editor/active-editor'
import { useBlockKeyboard } from '@/editor/use-block-keyboard'
import { useEditorEventDispatch } from '@/editor/use-editor-event-dispatch'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { BatchAttachmentsProvider } from '@/hooks/useBatchAttachments'
import { BatchPropertiesProvider } from '@/hooks/useBatchPropertyRows'
import { useScopedBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'
import { useLazyRovingEditor } from '@/hooks/useLazyRovingEditor'
import { useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { useViewportObserver } from '@/hooks/useViewportObserver'
import { useViewportWindow } from '@/hooks/useViewportWindow'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { serializeBlockSubtree } from '@/lib/block-clipboard'
import type { NavigateToPageFn } from '@/lib/block-events'
import type { BlockTypeToken } from '@/lib/block-type-convert'
import { convertBlockContent } from '@/lib/block-type-convert'
import { listStyleForBlockType, setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { searchPropertyKeys, searchSlashCommands } from '@/lib/slash-commands'
import type { FlatBlock } from '@/lib/tree-utils'
import { getDragDescendants } from '@/lib/tree-utils'
import { mountedScopedIds } from '@/lib/zoom-scope'
import { useBlockStore } from '@/stores/blocks'
import { storeOwnsBlock, usePageBlockStore, usePageBlockStoreApi } from '@/stores/page-blocks'
import { useSpaceStore } from '@/stores/space'

/**
 * Stable DnD measuring config — module-level to avoid re-creation per render.
 *
 * `WhileDragging` re-measures droppables only between drag operations
 * (and on every drag move), not on unrelated state changes. For our
 * usage this is identical to `Always` for drag UX because the tree
 * does not manually invalidate measurements via `measureDroppables()`
 * — the dnd-kit defaults handle the measurement lifecycle. See the
 * `DndContext` block below: only the standard `onDragStart` /
 * `onDragMove` / `onDragOver` / `onDragEnd` / `onDragCancel`
 * callbacks are wired, no manual measurement plumbing depends on
 * `Always`. (design-system-perf-review-2026-05-09.md item 14.)
 */
const DND_MEASURING = {
  droppable: { strategy: MeasuringStrategy.WhileDragging },
} as const

/**
 * Whether `blockId` is structurally inside the active zoom pane — a
 * `parent_id` ancestry walk, deliberately independent of collapse state.
 *
 * #4011: the `focusedBlockId` reveal effect below needs to tell "this target
 * can never be reached in the current pane" from "reachable, but the
 * ancestor-expansion this same effect just triggered hasn't landed yet" —
 * and the pane's own rendered list (`uncappedZoomedVisible`) cannot make that
 * distinction, because it is ALSO filtered by collapse state, which lags the
 * `expandAncestors` call by one render (the state update it schedules is not
 * applied yet). Walking the raw parent chain reads nothing collapse-
 * dependent, so it gives the same answer on the very render the target
 * enters focus as it would after every collapsed ancestor between it and the
 * zoom root has finished expanding.
 *
 * `visited` is not defensive dressing: this walk runs on the RENDER path, and
 * a `parent_id` cycle (a sync replay landing a moved block under its own
 * descendant, a partially applied reorder) would otherwise spin the main
 * thread forever with no error and no frame. Every other `parent_id` walk in
 * the app is bounded the same way — `expandAncestors`
 * (`use-block-collapse.ts`), `getDragDescendants` (`tree-utils.ts`),
 * `resolveFolderPath` (`jex-import.ts`) — so a cycle degrades to "not in the
 * pane", which the caller already handles, instead of a hang.
 */
function isInZoomPane(
  blockId: string,
  zoomedBlockId: string | null,
  blocksById: ReadonlyMap<string, FlatBlock>,
): boolean {
  if (zoomedBlockId === null) return true
  const visited = new Set<string>()
  let current = blocksById.get(blockId)
  while (current && !visited.has(current.id)) {
    if (current.id === zoomedBlockId) return true
    visited.add(current.id)
    current = current.parent_id ? blocksById.get(current.parent_id) : undefined
  }
  return false
}

interface BlockTreeProps {
  /** Optional parent block ID -- when set, loads children of this block. */
  parentId?: string | undefined
  /** Navigate to a page in the page editor (cross-page navigation).
   *  Optional blockId scrolls to a specific block within the target page. */
  onNavigateToPage?: NavigateToPageFn | undefined
  /** When true (default), auto-creates an empty first block on empty pages.
   *  Set to false to suppress auto-creation (e.g. weekly/monthly journal views). */
  autoCreateFirstBlock?: boolean | undefined
  /**
   * #4011 — reports the outcome of the `focusedBlockId` reveal effect below,
   * once BlockTree has done everything IT can for that id: `found: true` once
   * the row is actually in `mountedVisible`, `found: false` once the target
   * turns out not to be reachable in the active zoom pane at all (so no
   * further `expandAncestors`/`revealIndex` call would help). Lets a caller
   * (`PageEditor`'s navigation-intent effect) react to the REAL end state of
   * the reveal instead of inferring one from elapsed frames.
   *
   * Held in a ref and deliberately NOT a dependency of that effect: the
   * effect calls `expandAncestors` BEFORE its bail (#4002), a transient
   * reveal write, so an un-memoized callback would re-run that write on every
   * parent render.
   */
  onRevealSettled?: ((blockId: string, found: boolean) => void) | undefined
  /**
   * #4011 — a re-arm token for that same reveal. A caller bumps it to say
   * "report on `focusedBlockId` again", for the case where the reveal effect
   * has ALREADY run and reported for this id before anyone was listening:
   * `PageEditor` setting focus to a block that is already `focusedBlockId` is
   * a no-op, so nothing in the effect's other deps changes and no report
   * would ever arrive — the navigation would hang with no scroll, no notice
   * and the selection never cleared. Its VALUE is meaningless; only that it
   * changed matters, which is why it appears in the dependency list and
   * nowhere in the effect body.
   */
  revealNonce?: number | undefined
}

export function BlockTree({
  parentId,
  onNavigateToPage,
  autoCreateFirstBlock = true,
  onRevealSettled,
  revealNonce,
}: BlockTreeProps = {}): React.ReactElement {
  const { t } = useTranslation()
  // Per-page data from context
  const { blocks, blocksById, rootParentId, loading, truncatedTotal } = usePageBlockStore(
    useShallow((s) => ({
      blocks: s.blocks,
      blocksById: s.blocksById,
      rootParentId: s.rootParentId,
      loading: s.loading,
      truncatedTotal: s.truncatedTotal,
    })),
  )
  // Global focus/selection
  const { focusedBlockId, selectedBlockIds } = useBlockStore(
    useShallow((s) => ({ focusedBlockId: s.focusedBlockId, selectedBlockIds: s.selectedBlockIds })),
  )

  // Per-page store API for imperative access
  const pageStore = usePageBlockStoreApi()
  const {
    load,
    remove,
    edit,
    splitBlock,
    indent,
    dedent,
    reorder,
    moveToParent,
    moveBlocks,
    moveUp,
    moveDown,
    createBelow,
  } = pageStore.getState()
  // Global focus/selection actions
  const { setFocused, toggleSelected, clearSelected } = useBlockStore.getState()
  // #3344/#3642 — the three selection entry points carry the zoom-scope brands
  // on the STORE primitives themselves (`@/lib/zoom-scope`), so every id that
  // can reach the batch delete / batch TODO handlers had to come out of the
  // active projection. The gate used to be a set of narrowing adapters right
  // here, which closed the path for `BlockTree` and nobody else.
  const {
    rangeSelect: rawRangeSelect,
    selectAll: rawSelectAll,
    extendSelection,
  } = useBlockStore.getState()

  // ── Editor-event dispatch (#1019) ──────────────────────────────────
  // Owns the late-bound handler refs for the editor events whose handlers are
  // created further down in this render (slashCommand / checkbox /
  // propertySelect / beforeCollapse / flush), but whose consuming hooks run
  // earlier. `dispatch.thunks` are stable, captured up front; the real
  // handlers are registered via `dispatch.on(...)` and synced post-commit.
  // See `use-editor-event-dispatch.ts` for the concurrent-rendering rationale.
  const dispatch = useEditorEventDispatch()

  // ── Collapse hook (state + visible block filtering) ────────────────
  // onBeforeCollapse needs handleFlush (defined later), so it is dispatched
  // through the stable `beforeCollapse` thunk and registered via dispatch.on.
  const {
    collapsedIds,
    toggleCollapse,
    expandBlock,
    expandAncestors,
    visibleBlocks: collapseFilteredVisible,
    hasChildrenSet,
  } = useBlockCollapse(blocks, {
    onBeforeCollapse: dispatch.thunks.beforeCollapse,
    // #752 — persistence is scoped per page root (one pruned localStorage
    // entry per page instead of one unbounded global key).
    pageKey: rootParentId,
  })

  // ── Mount envelope (#2467) ──────────────────────────────────────────
  // Project the collapse-filtered list into the active zoom view BEFORE
  // applying the mount cap. Otherwise a zoomed pane inherits the page-wide
  // hidden count and offers to reveal rows that are not part of that pane
  // (#3254). See useBlockMountLimit for the envelope numbers.
  const {
    zoomedBlockId,
    zoomIn: rawZoomIn,
    zoomToRoot,
    breadcrumbs: zoomBreadcrumb,
    zoomedVisible: uncappedZoomedVisible,
    // Ctrl/Cmd+A's scope. Derived inside `useBlockZoom` (#3344) because that
    // is the module allowed to brand a list as zoom-scoped: the page-wide
    // arm is only reachable there, on the `zoomedBlockId === null` branch.
    // Uncapped on purpose — the mount envelope limits React rows, not the
    // semantic contents of the active zoom.
    selectAllIds,
    // `collapsedIds` (third arg) is the EFFECTIVE collapsed set: #4038 has the
    // zoomed projection re-apply collapse WITHIN the pane, from the unfiltered
    // tree, instead of inheriting the page-wide filtering — under which a
    // collapsed ANCESTOR of the zoom root emptied the pane outright.
  } = useBlockZoom(blocks, collapseFilteredVisible, collapsedIds)

  // Zoom means "show me inside this block". Expand the target through the
  // collapse hook's persisted, idempotent path before changing projection, so
  // the block the user just opened is still open in the saved layout when
  // they zoom back out. Since #4038 this is no longer what keeps the pane
  // from rendering blank — the zoomed projection ignores the zoom root's own
  // collapsed flag (it is the pane's root) — but the intent is still the
  // user's, so it is still saved.
  const handleZoomIn = useCallback(
    (blockId: string) => {
      expandBlock(blockId)
      rawZoomIn(blockId)
    },
    [expandBlock, rawZoomIn],
  )

  // Scope expansion to both the page and zoom root so an expanded envelope
  // cannot leak across either kind of navigation.
  const mountScopeKey = `${rootParentId ?? '__ROOT__'}:${zoomedBlockId ?? '__PAGE__'}`
  const {
    mounted: mountedVisible,
    hiddenCount: hiddenMountCount,
    expandMountLimit,
    revealIndex,
  } = useBlockMountLimit(uncappedZoomedVisible, { pageKey: mountScopeKey })

  // ── #3276: reveal a navigation target hidden by collapse or the mount cap ──
  // PageEditor sets `focusedBlockId` on a link/search-result jump; if the
  // target sits under a collapsed ancestor or past the mount cap, its row is
  // never mounted and the intent silently drops (no scroll, no highlight —
  // indistinguishable from a broken link). Expand any collapsed ancestor
  // chain first, then raise the mount cap to the target's position in the
  // (now collapse-corrected) visible list. Converges over a couple of
  // renders as `collapsedIds`/`mountScope` state updates cascade; a no-op
  // once the block is actually mounted, doesn't belong to this page, or
  // falls outside the current zoom pane (crossing a zoom boundary is a
  // separate, not-yet-addressed case — same scope note as
  // `mountCapExcludedIds` above). Still not addressed means exactly that:
  // focusing a block outside the pane does not bring it into view. It no
  // longer EMPTIES the pane either — the reveal released here can drop a
  // collapsed ancestor of the zoom root, which used to delete the pane's
  // whole contents until #4038 scoped the zoomed projection to the pane.
  //
  // #4002 — `expandAncestors` is deliberately called BEFORE the "already
  // mounted" bail: its reveal is transient and exclusive, so re-asserting the
  // CURRENT target on every focus move is also what releases the previous
  // one. Bailing early for a mounted target would strand the last reveal
  // open (harmlessly on disk, but visibly on screen) until the next jump into
  // a collapsed subtree. It is a no-op — reference-stable, and without even
  // the parent-chain walk — when nothing on the page is collapsed.
  //
  // Load-bearing consequence of that move: this effect also re-runs when
  // `mountedVisible` changes, i.e. when the user COLLAPSES something. Their
  // collapse of an ancestor of the focused block only sticks because the
  // `beforeCollapse` handler below clears `focusedBlockId` (the collapsing
  // subtree contains it), so this effect bails at the guard above instead of
  // recomputing the overlay from the persisted set and re-revealing what they
  // just closed. If that focus rescue ever stops clearing focus, re-check
  // this call — an ancestor of the focused block would become uncollapsable.
  //
  // #4011 — `onRevealSettled` reports the two DECIDABLE end states of this
  // reveal, computed from the same state this effect already reads rather
  // than guessed from elapsed time: `found: true` once `focusedBlockId` is
  // actually in `mountedVisible` (the row exists, nothing left to do), and
  // `found: false` once `isInZoomPane` says it structurally cannot be —
  // outside the active zoom pane, the one case this effect cannot reveal (see
  // the "not-yet-addressed" note above) and never will on its own, so there
  // is no more waiting to do. `isInZoomPane` (not `uncappedZoomedVisible`
  // membership) is what decides "false": the rendered pane list is ALSO
  // collapse-filtered, and collapse state lags the `expandAncestors` call
  // above by one render, so a target that is genuinely reachable but merely
  // not-yet-expanded would otherwise read as unreachable on this very render.
  // The one remaining branch — in the pane, not yet mounted — calls
  // `revealIndex` and reports NOTHING: it is still in progress, and this same
  // effect re-runs (via the `mountedVisible` dep) once that state update
  // lands, at which point one of the two decidable branches above fires. A
  // caller (`PageEditor`) no longer has to infer "stalled" from a frame count
  // that was always a proxy for this same information.
  //
  // #4012 review note 4 — the callback is read through a ref rather than
  // being a dependency. This effect's FIRST statement is `expandAncestors`, a
  // transient-reveal state write that must run once per focus move and not
  // once per parent render; with the callback in the deps, a caller that
  // passes an inline (un-memoized) `onRevealSettled` would re-trigger that
  // write on every render of ITS parent. `PageEditor` memoizes today — this
  // makes the effect independent of whether the next caller remembers to.
  const onRevealSettledRef = useRef(onRevealSettled)
  useEffect(() => {
    onRevealSettledRef.current = onRevealSettled
  })
  useEffect(() => {
    if (!focusedBlockId) return
    if (!blocksById.has(focusedBlockId)) return
    expandAncestors(focusedBlockId)
    if (mountedVisible.some((b) => b.id === focusedBlockId)) {
      onRevealSettledRef.current?.(focusedBlockId, true)
      return
    }
    if (!isInZoomPane(focusedBlockId, zoomedBlockId, blocksById)) {
      onRevealSettledRef.current?.(focusedBlockId, false)
      return
    }
    const idx = uncappedZoomedVisible.findIndex((b) => b.id === focusedBlockId)
    if (idx >= 0) revealIndex(idx)
  }, [
    focusedBlockId,
    blocksById,
    mountedVisible,
    uncappedZoomedVisible,
    zoomedBlockId,
    expandAncestors,
    revealIndex,
    // Re-arm only (see `revealNonce` on `BlockTreeProps`): unused in the body
    // ON PURPOSE — it exists to re-run this effect when nothing else changed.
    revealNonce,
  ])

  // ── Mount-cap exclusion set for the metadata window (#2580) ─────────────
  // `useViewportWindow` (below) conservatively treats any never-measured
  // block as "in window" — correct for a block that's mounted but hasn't
  // been through the IntersectionObserver yet, wrong for a block
  // `useBlockMountLimit` excluded from the mounted tree altogether: that
  // block will never mount, so it will never be measured, so the
  // conservative rule would keep issuing metadata IPCs for it forever. Name
  // exactly the ids the mount cap dropped in the currently rendered
  // projection — `uncappedZoomedVisible` minus `mountedVisible` (the
  // capped, actually-mounted list) — so the window can subtract them.
  // Deliberately does NOT extend to collapse-hidden or zoomed-out blocks
  // (a pre-existing, separate over-inclusion #1268/#2467 already share, see
  // useBlockMountLimit's file header) — this stays a bounded fix for the
  // mount-cap specifically. The focused block is carved back out even if
  // it falls past the cap (e.g. a link-navigation jump on a huge page,
  // before the cap has expanded to reach it): mirrors SortableBlockWrapper's
  // "focused block is never virtualized" rule, so a focused row's metadata
  // is never starved by this exclusion.
  // #3277 — `focusedBlockId` deliberately does NOT appear in this memo's
  // deps. It used to (to carve the focused row back out of the excluded
  // set inline, below), which meant EVERY focus move rebuilt this Set by
  // rescanning the full `uncappedZoomedVisible` list (page-sized, not
  // window-sized) — and, because the resulting Set gets a fresh identity,
  // cascaded an equally page-sized recompute through `useViewportWindow`'s
  // filter and `useBlockLinkResolve`'s `contentSignature` join. The carve-
  // out itself is still applied, just downstream on the already
  // viewport-bounded `windowedBlocks` result (see `windowedBlocksWithFocus`
  // below) — cheap regardless of page size, and a true no-op in the
  // overwhelming common case where the focused row is mounted (and thus
  // was never excluded here to begin with).
  const mountCapExcludedIds = useMemo(() => {
    if (hiddenMountCount === 0) return null
    const mountedIds = new Set(mountedVisible.map((b) => b.id))
    const excluded = new Set<string>()
    for (const b of uncappedZoomedVisible) {
      if (!mountedIds.has(b.id)) excluded.add(b.id)
    }
    return excluded.size > 0 ? excluded : null
  }, [uncappedZoomedVisible, mountedVisible, hiddenMountCount])

  // ── Capped active projection ────────────────────────────────────────────
  // Keep one name for the capped active projection consumed by DnD,
  // keyboard/range navigation, and rendering below.
  const zoomedVisible = mountedVisible

  // #1063 — the ids of the rows actually rendered (collapsed/zoomed-out blocks
  // filtered out). Both mouse Shift+Click range-select (handleSelect) and the
  // Shift+Arrow keyboard range-select slice against this so neither ever pulls
  // an invisible block into the selection. Memoized so the document keydown
  // listener (useBlockTreeKeyboardShortcuts) doesn't re-attach every render.
  // #3344 — `mountedScopedIds` carries the mount-scope brand across the
  // `FlatBlock[]` → `string[]` projection, so the selection entry points below
  // cannot be handed the page-wide list instead.
  const visibleIds = useMemo(() => mountedScopedIds(zoomedVisible), [zoomedVisible])

  // #1066 — `visibleIds` is re-derived from `blocks` on every edit, so a
  // `handleSelect` that closed over it would get a new identity per edit and
  // bust the `blockActions` context bag (re-rendering every memoized row).
  // Keep a commit-synced ref so `handleSelect` can read the CURRENT visible
  // ids at call time while staying referentially stable across edits. This
  // preserves #1063's visible-only range-select semantics without the closure
  // dependency. The mirror is written from a layout effect with no dep array,
  // so it refreshes on every commit and lands before any passive effect or
  // user event can read it.
  const visibleIdsRef = useRef(visibleIds)
  useLayoutEffect(() => {
    visibleIdsRef.current = visibleIds
  })

  // ── Enter-creates-block refs ───────────────────────────────────────
  const justCreatedBlockIds = useRef(new Set<string>())
  const prevFocusedRef = useRef<string | null>(null)

  // ── Block-level dialog surfaces (#2930) ────────────────────────────
  // State + open/close/act handlers for the block-history sheet, property
  // drawer, visual query builder (#215) and emoji picker (#286). The MOUNTS
  // render in <BlockTreeDialogs/> below, fed by this hook's returned values.
  const {
    historyBlockId,
    setHistoryBlockId,
    propertyDrawerBlockId,
    setPropertyDrawerBlockId,
    queryBuilderOpen,
    setQueryBuilderOpen,
    emojiPickerOpen,
    setEmojiPickerOpen,
    handleShowHistory,
    handleShowProperties,
    openQueryBuilder,
    openEmojiPicker,
    handleEmojiSelect,
    handleQuerySave,
  } = useBlockDialogs({ focusedBlockId, pageStore, load })

  // ── Extracted hooks ────────────────────────────────────────────────
  const resolve = useBlockResolve()
  const onTagClick = useTagClickHandler()
  const properties = useBlockProperties()
  const { handleToggleTodo, handleTogglePriority } = properties

  // ── Refs that bridge handlers defined later in the render ──────────
  // `rovingEditorRef` is read by `handleNavigate` (and others) which run
  // before `useRovingEditor` returns. The editor-event handler indirections
  // (slashCommand / checkbox / propertySelect / flush) are owned by
  // `dispatch` above; `handleNavigateRef` is owned by `useBlockNavigateToLink`.
  const rovingEditorRef = useRef<RovingEditorHandle | null>(null)

  // ── Block-link navigation hook (owns handleNavigateRef indirection) ─
  const { handleNavigate, handleNavigateRef } = useBlockNavigateToLink({
    rovingEditorRef,
    handleFlushRef: dispatch.flushRef,
    load,
    setFocused,
    rootParentId,
    onNavigateToPage,
    t,
  })

  // ── Context-aware placeholder for the editor ────────────────────────
  // Default empty-block placeholder advertises the slash-command palette,
  // which was previously only discoverable via `?` keyboard help. The first child
  // of an empty page keeps the more specific template hint.
  const editorPlaceholder = useMemo(() => {
    const defaultPlaceholder = t('editor.emptyBlockPlaceholder')
    if (!focusedBlockId || blocks.length === 0) return defaultPlaceholder
    const focused = blocksById.get(focusedBlockId)
    if (!focused) return defaultPlaceholder
    const isFirstChild = blocks[0]?.id === focusedBlockId
    const isEmpty = !focused.content || focused.content.trim() === ''
    if (isFirstChild && isEmpty) {
      return t('editor.templatePlaceholder')
    }
    return defaultPlaceholder
  }, [focusedBlockId, blocks, blocksById, t])

  // #2939 — lazy roving editor. `rovingEditor` is a drop-in `RovingEditorHandle`
  // facade (identical contract for every consumer below); the heavy TipTap
  // module + `Editor` instance load off the cold-start path via `editorHost`.
  const { rovingEditor, editorHost, editorSurface } = useLazyRovingEditor({
    resolveBlockTitle: resolve.resolveBlockTitle,
    resolveTagName: resolve.resolveTagName,
    onNavigate: (id: string) => handleNavigateRef.current(id),
    onTagClick,
    searchTags: resolve.searchTags,
    searchPages: resolve.searchPages,
    searchBlockRefs: resolve.searchBlockRefs,
    onCreatePage: resolve.onCreatePage,
    onCreateTag: resolve.onCreateTag,
    searchSlashCommands,
    onSlashCommand: dispatch.thunks.slashCommand,
    onCheckbox: dispatch.thunks.checkbox,
    onListStyle: dispatch.thunks.listStyle,
    searchPropertyKeys,
    onPropertySelect: dispatch.thunks.propertySelect,
    placeholder: editorPlaceholder,
  })

  // (#752) `rovingEditorRef` is synced in the consolidated ref-sync layout
  // effect below — writing it here during render was a concurrent-rendering
  // hazard (a thrown/abandoned render would publish a handle from a render
  // that never committed).

  // #82 — publish this BlockTree's roving editor to the module
  // registry so app-level UI outside the tree (the command palette's
  // `[[Page]]` insert) can run undo-preserving commands. Keyed on FOCUS,
  // not mount: the journal week/month views mount several BlockTrees at
  // once, so "the editor to insert into" is the one the caret was last
  // in — not whichever mounted last. We do NOT clear on blur (opening the
  // palette blurs the editor, yet that editor is still the target); the
  // unmount clear is guarded so it can't clobber another live instance.
  useEffect(() => {
    const editor = rovingEditor.editor
    if (editor == null) return
    const publish = (): void => setActiveEditor(editor)
    if (editor.isFocused) publish()
    editor.on('focus', publish)
    return () => {
      editor.off('focus', publish)
      if (getActiveEditor() === editor) setActiveEditor(null)
    }
  }, [rovingEditor.editor])

  const viewport = useViewportObserver()

  // #1268 — the page's block list is rendered windowed (off-screen rows become
  // placeholders), but the per-page batch metadata IPCs (properties, links,
  // attachments) historically fetched for EVERY block, so a single edit on a
  // large page re-issued an O(N) IPC + O(N) reconciliation for the whole page.
  // Scope those fetches to the rows actually inside the viewport window (plus
  // the observer's rootMargin) by reusing the SAME viewport source the renderer
  // uses — no parallel windowing mechanism. A block scrolled into view re-enters
  // this set and gets its metadata resolved lazily; the downstream hooks keep
  // their signature/contentSignature guards and reference-stable maps intact.
  // #2580 — also subtract `mountCapExcludedIds`: rows the mount cap (#2467)
  // excluded from the mounted tree entirely would otherwise sit in this
  // window forever (never measured ⇒ never flips off-screen).
  const windowedBlocks = useViewportWindow(viewport, blocks, mountCapExcludedIds)

  // #3277/#2580 — re-apply the focused-row carve-out that `mountCapExcludedIds`
  // no longer encodes (see its definition above): if the focused block was
  // dropped by the mount cap and is consequently missing from `windowedBlocks`,
  // add it back so its metadata still resolves — mirrors
  // SortableBlockWrapper's "focused block is never virtualized" rule. Bounded
  // by `windowedBlocks.length` (viewport-window-sized), not page size, and
  // returns the SAME array reference (no-op) whenever no correction is
  // needed — i.e. every focus move except the rare one landing on a row the
  // mount cap hasn't caught up to yet.
  const windowedBlocksWithFocus = useMemo(() => {
    if (
      focusedBlockId == null ||
      !mountCapExcludedIds?.has(focusedBlockId) ||
      windowedBlocks.some((b) => b.id === focusedBlockId)
    ) {
      return windowedBlocks
    }
    const focusedBlock = uncappedZoomedVisible.find((b) => b.id === focusedBlockId)
    return focusedBlock ? [...windowedBlocks, focusedBlock] : windowedBlocks
  }, [windowedBlocks, focusedBlockId, mountCapExcludedIds, uncappedZoomedVisible])

  // ── Date picker hook ───────────────────────────────────────────────
  const {
    datePickerOpen,
    datePickerCursorPos,
    setDatePickerOpen,
    setDatePickerMode,
    handleDatePick,
  } = useBlockDatePicker({
    focusedBlockId,
    rootParentId,
    pageStore,
    rovingEditor,
    registerCreatedPage: resolve.registerCreatedPage,
    t,
  })

  // ── Slash commands hook ────────────────────────────────────────────
  const {
    handleSlashCommand,
    handleTemplateSelect,
    handleCheckboxSyntax,
    handleListStyleSyntax,
    templatePickerOpen,
    setTemplatePickerOpen,
    templatePages,
  } = useBlockSlashCommands({
    focusedBlockId,
    rootParentId,
    pageStore,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    blocks,
    load,
    t,
    openQueryBuilder,
    openEmojiPicker,
    openPropertyDrawer: handleShowProperties,
  })

  // ── Multi-select hook ──────────────────────────────────────────────
  // #4524 — `currentSpaceId` is read HERE, above the hook that consumes it,
  // rather than at its old site next to `batchPropertiesInvalidationKey`
  // further down (which still uses it). The batch delete needs the ORIGIN
  // space to scope its `[[` name-cache eviction to, and it must be the value
  // rendered when the user clicked, not a fresh read after the IPC settles.
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId)
  const {
    batchDeleteConfirm,
    batchInProgress,
    setBatchDeleteConfirm,
    handleBatchSetTodo,
    handleBatchSetPriority,
    handleBatchDelete,
  } = useBlockMultiSelect({
    selectedBlockIds,
    clearSelected,
    rootParentId,
    pageStore,
    currentSpaceId,
    t,
    handleTogglePriority,
  })

  // Reload + reset zoom when the page changes (parentId). `load` and
  // `zoomToRoot` are stable identities, so listing them is safe and only
  // `parentId` actually drives re-runs.
  useEffect(() => {
    // The store's `load` logs its own failure; never rejects.
    void load()
    zoomToRoot()
  }, [load, parentId, zoomToRoot])

  // ── H-9: Auto-create first block on empty pages ─────────────────────
  useBlockAutoCreateFirstBlock({
    enabled: autoCreateFirstBlock,
    loading,
    blocksLength: blocks.length,
    rootParentId,
    pageStore,
    t,
  })

  // ── #922: seed a first child when zoomed into an empty (leaf) block ──
  // Keyboard zoom-in no longer requires children, so a zoomed leaf would
  // otherwise show a blank pane. Insert a child UNDER the zoom root via a
  // non-wholesale splice (the page outside the zoom root is preserved).
  useBlockZoomEmptySeed({
    enabled: autoCreateFirstBlock,
    loading,
    zoomedBlockId,
    zoomRootHasChildren: zoomedBlockId !== null && hasChildrenSet.has(zoomedBlockId),
    pageStore,
    t,
  })

  // Scan loaded blocks for [[ULID]] tokens not yet in the resolve cache
  // and batch-fetch them. See `useBlockLinkResolve` for the cache-scope
  // And rationale. #1268 — scoped to the viewport window so a
  // single edit on a large page no longer re-scans + re-resolves the whole
  // page; a row scrolled into view enters `windowedBlocks` and resolves then.
  useBlockLinkResolve(windowedBlocksWithFocus)

  // #2288 — the per-block "extra" properties for the row UI are now derived
  // from the single page-wide `BatchPropertiesProvider` batch (mounted below),
  // inside `BlockListRenderer`, instead of a SECOND identical
  // `getBatchProperties` IPC issued here. See BlockListRenderer /
  // useExtraBlockProperties.

  // ── Editor flush callback (split + checkbox/todo persistence) ──────
  const handleFlush = useBlockFlush({
    rovingEditorRef,
    edit,
    splitBlock,
    rootParentId,
    pageStore,
  })

  // (`handleFlush` — read lazily by `useBlockNavigateToLink` via
  // `dispatch.flushRef` — is registered via `dispatch.on('flush', …)` below
  // and synced post-commit by the dispatch hook, #752/#1019.)

  // #264 — "Turn into" from the block context-menu. Converts the right-clicked
  // / long-pressed block (which may differ from the focused block) to the
  // chosen type by rewriting its markdown content via the shared
  // `convertBlockContent` helper — the same conversion the `/turn` slash
  // command runs, so the logic is not duplicated.
  const handleTurnInto = useCallback(
    async (blockId: string, blockType: BlockTypeToken) => {
      // The context menu opens without flushing (its data-editor-portal
      // suppresses the blur persist), so the STORE content of a focused block
      // can lag live typing. Flush the mounted editor first so the conversion
      // reads the live text, and REMOUNT with the converted content after —
      // otherwise the still-mounted editor keeps the pre-conversion doc
      // invisible on screen and its next blur silently overwrites the
      // conversion. Mirrors the toolbar path (useBlockTreeEventListeners
      // onTurnInto → readCurrentContent + applyContentEdit).
      const isLive = rovingEditorRef.current?.activeBlockId === blockId
      if (isLive) handleFlush()
      const current = pageStore.getState().blocksById.get(blockId)
      if (!current) return
      const newContent = convertBlockContent(current.content ?? '', blockType)
      // #2662 — route through `pageStore.edit()` (same as this hook's own
      // `handleQuerySave` above) instead of a raw `editBlock` IPC call.
      // `edit()` owns the undo-store contract: it resets the redo stack via
      // `notifyUndoNewAction` (page-blocks-reducers.ts) so a later Ctrl+Z /
      // Ctrl+Shift+Z can't resurrect the pre-conversion content past this
      // mutation — the raw IPC call left that positional undo state stale
      // (mirrors the identical bug already fixed for slash commands, see
      // `applyContentEdit` in useBlockSlashCommands/helpers.ts). `edit()`
      // also surfaces its own save-failed toast and rolls back on failure,
      // so no separate try/catch is needed here.
      const ok = await pageStore.getState().edit(blockId, newContent)
      if (!ok) return
      if (isLive) rovingEditorRef.current?.mount(blockId, newContent)
      // #4552 slice 2 — write the `listStyle` property `blockType` implies:
      // 'ordered'/'bullet' for the two list targets, cleared for every other
      // target, so converting a styled block away from a list does not leave
      // it flagged as one. See `useSlashCommandStructural.handleTurnInto`'s
      // matching comment for the full rationale.
      try {
        await setListStyle(blockId, listStyleForBlockType(blockType))
      } catch (err) {
        logger.error('BlockTree', 'setListStyle (turn-into) failed', { blockId }, err)
        notify.error(t('slash.turnIntoFailed'))
      }
      await load()
    },
    [pageStore, load, handleFlush, t],
  )

  // #976 (item 13) — Duplicate a block + its subtree, inserting the copy
  // immediately after the original at the same depth. This reuses the existing
  // copy/paste-outline store ops (`serializeBlockSubtree` → `pasteBlocks`)
  // rather than introducing a new clone op: serialize just this block's subtree
  // to indented markdown, then paste it anchored on the original (paste inserts
  // after the anchor at the anchor's depth). No new store op is required.
  const handleDuplicate = useCallback(
    async (blockId: string) => {
      // Same staleness seam as handleTurnInto: the duplicate chord and the
      // context-menu row fire with the editor still mounted, so serializing
      // the store snapshot would copy stale content. Capture → flush →
      // remount (the handleIndent pattern) so the copy carries the live text
      // and the original stays open for editing.
      const re = rovingEditorRef.current
      if (re?.activeBlockId === blockId) {
        const live = re.getMarkdown?.() ?? ''
        handleFlush()
        re.mount(blockId, live)
      }
      const state = pageStore.getState()
      if (!state.blocksById.has(blockId)) return
      const markdown = serializeBlockSubtree(state.blocks, [blockId])
      if (markdown.length === 0) return
      try {
        await state.pasteBlocks(blockId, markdown)
      } catch (err) {
        logger.error('BlockTree', 'Failed to duplicate block', { blockId }, err)
        notify.error(t('blockTree.duplicateFailed'))
      }
    },
    [pageStore, handleFlush, t],
  )

  // ── Scroll container ref (for auto-scroll during drag) ──────────────
  const scrollContainerRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    scrollContainerRef.current = document.getElementById('main-content')
  }, [])

  // ── DnD hook (needs handleFlush + collapsedVisible) ────────────────
  // #712: when zoomed, the DnD projection's "root" is the zoomed block, not
  // the page root. `zoomedVisible` rebases `depth` to 0 at the zoomed block's
  // children but keeps real `parent_id`s, so a depth-0 drop must resolve to
  // the zoomed block — passing the page `rootParentId` here made every
  // in-place reorder look like a reparent and ejected the block out of the
  // zoomed subtree.
  const dnd = useBlockDnD({
    blocks,
    collapsedVisible: zoomedVisible,
    rootParentId: zoomedBlockId ?? rootParentId,
    rovingEditor,
    // #914 — feed the global multi-selection so dragging a selected block moves
    // the whole selection (the hook collapses it to roots + branches on >1).
    selectedBlockIds,
    handleFlush,
    setFocused,
    reorder,
    moveToParent,
    moveBlocks,
    scrollContainerRef,
  })

  // (`beforeCollapse` is registered via `dispatch.on(...)` below, #752,
  // now that `handleFlush` is available.)

  // ── B-14: Clear focus when zoom changes and focused block is outside view ──
  useEffect(() => {
    if (zoomedBlockId === null) return // root view — all blocks visible
    const { focusedBlockId: fid } = useBlockStore.getState()
    if (!fid) return
    const descendants = getDragDescendants(blocks, zoomedBlockId)
    if (!descendants.has(fid)) {
      handleFlush()
      setFocused(null)
    }
  }, [zoomedBlockId, blocks, handleFlush, setFocused])

  // ── Late-bound editor-event handler registration (#752/#1019) ───────
  // These handlers are created at different points of this render but their
  // consuming hooks (`useRovingEditor`, `useBlockCollapse`,
  // `useBlockNavigateToLink`) captured stable `dispatch.thunks` earlier.
  // Registering here routes the real handlers through the dispatch hook,
  // which publishes them into its backing refs in a single post-commit
  // `useLayoutEffect` — the concurrent-rendering-safe replacement for writing
  // refs during render. See `use-editor-event-dispatch.ts` for the rationale.
  dispatch.on('flush', handleFlush)
  dispatch.on('slashCommand', handleSlashCommand)
  dispatch.on('checkbox', handleCheckboxSyntax)
  dispatch.on('listStyle', handleListStyleSyntax)
  // #2656 — the `::` picker's extension already inserts the `key:: ` inline
  // text; it no longer fires `setProperty({ valueText: '' })` (the real backend
  // rejects an empty value_text, so that produced a "Failed to set property"
  // toast and created nothing on the shipped app). No `propertySelect` handler
  // is registered — the value is entered inline after `key:: `, and #2675's
  // save-time parser in `useBlockFlush` commits the `key:: value` line to the
  // property system (stripping it from the content) when the block flushes.
  // The default no-op `propertySelect` thunk stays wired via `onPropertySelect`.
  // beforeCollapse — rescue focus (flush + clear) when the collapsing subtree
  // contains the focused block.
  dispatch.on('beforeCollapse', (blockId: string) => {
    if (focusedBlockId) {
      const descendants = getDragDescendants(blocks, blockId)
      if (descendants.has(focusedBlockId)) {
        handleFlush()
        setFocused(null)
      }
    }
  })

  // `rovingEditorRef` carries the editor HANDLE (not an event handler) to
  // consumers that captured it earlier (`useBlockNavigateToLink`, etc.).
  // Synced post-commit for the same concurrent-rendering reason: writing it
  // during render would publish a handle from a render that never committed.
  // No dependency array on purpose — the sync must track every commit.
  // (`handleNavigateRef` is owned by `useBlockNavigateToLink` above.)
  useLayoutEffect(() => {
    rovingEditorRef.current = rovingEditor
  })

  // ── Draft discard callback for Escape ────────────────────────────────
  const handleDiscardDraft = useCallback((blockId: string) => {
    commands
      .deleteDraft(blockId)
      .then(unwrap)
      .catch((err: unknown) => {
        logger.warn('BlockTree', 'Failed to delete draft on discard', { blockId }, err)
      })
  }, [])

  // ── Keyboard handlers hook ─────────────────────────────────────────
  const {
    handleFocusPrev,
    handleFocusNext,
    handleDeleteBlock,
    handleIndent: handleIndentKey,
    handleDedent: handleDedentKey,
    handleMoveUp,
    handleMoveDown,
    handleIndentById,
    handleDedentById,
    handleMoveUpById,
    handleMoveDownById,
    handleMergeWithPrev,
    handleMergeById,
    handleEnterSave,
    handleEscapeCancel,
  } = useBlockActionOrchestration({
    focusedBlockId,
    // #3251 — the hook's document-order neighbour lookups (focus-prev/next,
    // delete's last-block guard + refocus, merge-with-prev's merge target)
    // must stay within the RENDERED rows, same as `useBlockDnD` above
    // (#712) and `visibleIds` below (#922) already do. Passing the
    // un-zoomed `collapsedVisible` here let arrow keys and Backspace-merge
    // step onto — and mount the roving editor on — a row outside the zoomed
    // subtree that BlockListRenderer never rendered. `zoomedVisible` falls
    // back to `collapsedVisible` verbatim when not zoomed, so this is a
    // no-op outside zoom. `blocks` (below) stays the FULL flat tree — the
    // merge handlers' `planChildReparent` needs it to see a collapsed
    // source's hidden children.
    collapsedVisible: zoomedVisible,
    blocks,
    rovingEditor,
    setFocused,
    handleFlush,
    // The store's `remove` swallows its own errors (it logs + toasts and
    // resolves void, never rejects), so a failed delete_block would let the
    // merge handlers report success and leave the merged text duplicated in
    // both blocks — their remove-failure revert path could never fire. Same
    // seam as the `moveBlocks` wrapper below: verify the block actually left
    // the store and THROW if not, so the hook's failure paths are live.
    remove: useCallback(
      async (id: string) => {
        await remove(id)
        if (pageStore.getState().blocksById.has(id)) {
          throw new Error('remove incomplete: block still present after delete')
        }
      },
      [remove, pageStore],
    ),
    // #1342 — the merge handlers reparent a merged-away block's children onto
    // the merge target BEFORE removing the source, so the backend delete
    // cascade can't soft-delete the subtree. But `moveBlocks` swallows its own
    // errors (it logs + reloads, never rejects), so a partial/total move
    // failure would resolve "ok" and let `remove` cascade-delete the children
    // that DIDN'T move — re-introducing the very data loss this fixes. Wrap it
    // to verify against the freshly-reloaded tree that every requested child
    // now sits under the new parent, and THROW if not — so the hook's
    // reparent-failure path (revert edit, skip remove) actually fires.
    moveBlocks: useCallback(
      async (ids: string[], newParentId: string | null, newIndex: number) => {
        await moveBlocks(ids, newParentId, newIndex)
        const fresh = pageStore.getState().blocks
        const byId = new Map(fresh.map((b) => [b.id, b]))
        const stranded = ids.filter((id) => {
          const b = byId.get(id)
          // A child that vanished or whose parent is still NOT the target was
          // not (fully) reparented — treat as a failed move so the merge aborts.
          return !b || (b.parent_id ?? null) !== newParentId
        })
        if (stranded.length > 0) {
          throw new Error(`reparent incomplete: ${stranded.length} block(s) not under new parent`)
        }
      },
      [moveBlocks, pageStore],
    ),
    edit,
    indent,
    dedent,
    moveUp,
    moveDown,
    createBelow,
    justCreatedBlockIds,
    discardDraft: handleDiscardDraft,
    t,
  })

  // ── Multi-selection handler (Ctrl+Click / Shift+Click) ──────────────
  const handleSelect = useCallback(
    (blockId: string, mode: 'toggle' | 'range') => {
      if (mode === 'toggle') {
        toggleSelected(blockId)
      } else {
        // #1063 — slice against the RENDERED rows only. Passing the full
        // `blocks` list silently pulled every collapsed/zoomed-out block
        // between the two clicked rows into the selection (then batch
        // deleted/modified). Matches the keyboard range-select path.
        // #1066 — read the current visible ids from a render-synced ref so
        // this callback stays referentially stable across edits (keeps the
        // blockActions bag identity stable → per-row React.memo holds).
        rawRangeSelect(blockId, visibleIdsRef.current)
      }
    },
    [toggleSelected, rawRangeSelect],
  )

  // ── Focused-block command handlers (#2930) ─────────────────────────
  // Stable identities feeding the document-level `useBlockKeyboard` listener;
  // each runs its action against the currently focused block.
  const {
    handleToggleFocusedTodo,
    handleToggleFocusedCollapse,
    handleShowFocusedProperties,
    handleShowFocusedHistory,
    handleDuplicateFocused,
    handleTurnIntoFocused,
  } = useFocusedBlockActions({
    focusedBlockId,
    handleToggleTodo,
    toggleCollapse,
    handleShowProperties,
    handleShowHistory,
    handleDuplicate,
    rovingEditor,
  })

  useBlockKeyboard(rovingEditor.editor, {
    onFocusPrev: handleFocusPrev,
    onFocusNext: handleFocusNext,
    onDeleteBlock: handleDeleteBlock,
    onIndent: handleIndentKey,
    onDedent: handleDedentKey,
    onMoveUp: handleMoveUp,
    onMoveDown: handleMoveDown,
    onFlush: handleFlush,
    onMergeWithPrev: handleMergeWithPrev,
    onEnterSave: handleEnterSave,
    onEscapeCancel: handleEscapeCancel,
    onToggleTodo: handleToggleFocusedTodo,
    onToggleCollapse: handleToggleFocusedCollapse,
    onShowProperties: handleShowFocusedProperties,
    onShowHistory: handleShowFocusedHistory,
    onDuplicate: handleDuplicateFocused,
    onTurnInto: handleTurnIntoFocused,
  })

  // ── Extracted event listeners (custom DOM events from toolbar) ───────
  useBlockTreeEventListeners({
    focusedBlockId,
    rootParentId,
    handleEscapeCancel,
    handleToggleTodo,
    handleTogglePriority,
    handleShowProperties,
    handleOpenQueryBuilder: openQueryBuilder,
    handleOpenEmojiPicker: openEmojiPicker,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    pageStore,
    t,
  })

  // ── Empty-block cleanup: delete just-created blocks left empty ─────
  useEffect(() => {
    const prevId = prevFocusedRef.current
    prevFocusedRef.current = focusedBlockId

    if (prevId && prevId !== focusedBlockId && justCreatedBlockIds.current.has(prevId)) {
      justCreatedBlockIds.current.delete(prevId)
      const block = pageStore.getState().blocksById.get(prevId)
      if (block && (!block.content || block.content.trim() === '')) {
        // The store's `remove` logs its own failure; never rejects.
        void remove(prevId)
      }
    }
  }, [focusedBlockId, remove, pageStore])

  // ── Extracted keyboard shortcuts (document-level keydown listeners) ─
  useBlockTreeKeyboardShortcuts({
    focusedBlockId,
    pageStore,
    selectedBlockIds,
    hasChildrenSet,
    selectAllIds,
    // #922 — Shift+Arrow keyboard range-select steps through the RENDERED list
    // (`zoomedVisible` == `collapsedVisible` at root view), so it matches what
    // the user sees and respects collapsed/zoomed visibility.
    visibleIds,
    toggleCollapse,
    rawSelectAll,
    extendSelection,
    toggleSelected,
    clearSelected,
    handleFlush,
    setFocused,
    handleToggleTodo,
    handleSlashCommand,
    rovingEditor,
    datePickerCursorPos,
    setDatePickerMode,
    setDatePickerOpen,
    zoomedBlockId,
    zoomToRoot,
    zoomIn: handleZoomIn,
  })

  // ── Click on whitespace within block tree closes editor ──
  const handleContainerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.target !== e.currentTarget) return
      const { focusedBlockId: fid } = useBlockStore.getState()
      if (!fid) return
      // If the editor DOM still has focus, blur it so EditableBlock's
      // handleBlur fires the normal save-and-close path.
      const proseMirror = document.querySelector('.ProseMirror')
      if (proseMirror?.contains(document.activeElement)) {
        ;(document.activeElement as HTMLElement)?.blur()
      } else {
        // Editor is mounted but already unfocused — flush (save + split) before closing
        handleFlush()
        setFocused(null)
      }
    },
    [handleFlush, setFocused],
  )

  // ── Active item for DragOverlay ────────────────────────────────────
  const activeBlock = dnd.activeId ? (blocksById.get(dnd.activeId) ?? null) : null
  // R8 (#407): how many blocks the drag is actually moving (the active block
  // plus its descendant subtree) — surfaced as a badge on the overlay.
  // #752 — count over the FULL `blocks` list, not `collapsedVisible`: a drag
  // always moves the whole subtree, so dragging a COLLAPSED parent (whose
  // children are filtered out of `collapsedVisible`) must still show the
  // real subtree size instead of "1". Memoised: BlockTree re-renders on every
  // drag-move (`offsetLeft`/`overId` state in useBlockDnD), while `blocks`
  // and `activeId` are stable for the whole drag — without the memo the O(n)
  // subtree scan would re-run per pointer move on large pages.
  // #914 — when the drag is a multi-select move, the badge must reflect the
  // number of blocks ACTUALLY moving: every selection root plus its subtree.
  // (Roots are already de-nested, so their subtrees don't overlap.) Otherwise
  // it's the single active block + its subtree, as before.
  const draggingCount = useMemo(() => {
    if (!dnd.activeId) return 1
    if (dnd.isMultiDrag) {
      return dnd.dragRoots.reduce(
        (sum, rootId) => sum + getDragDescendants(blocks, rootId).size + 1,
        0,
      )
    }
    return getDragDescendants(blocks, dnd.activeId).size + 1
  }, [blocks, dnd.activeId, dnd.isMultiDrag, dnd.dragRoots])

  // #2943 — dnd-kit's DEFAULT screen-reader announcements read the raw block
  // ULID ("Picked up draggable item 01J8…") because `DndContext` had no
  // `accessibility` prop. Resolve a human-readable label the same way
  // `BlockDndOverlay`'s drag-preview ghost does (`content` trimmed), falling
  // back to a generic "block" label — never the id — when content is empty
  // or the id can't be resolved (e.g. the drop sentinel).
  const resolveDndBlockLabel = useCallback(
    (id: string | number | null | undefined): string => {
      if (id == null) return t('dnd.genericBlock')
      const block = blocksById.get(String(id))
      const text = block?.content?.trim()
      return text || t('dnd.genericBlock')
    },
    [blocksById, t],
  )

  const dndAnnouncements = useMemo<Announcements>(
    () => ({
      onDragStart: ({ active }) => t('dnd.pickedUp', { block: resolveDndBlockLabel(active.id) }),
      onDragOver: ({ active, over }) =>
        over
          ? t('dnd.movedOver', {
              block: resolveDndBlockLabel(active.id),
              target: resolveDndBlockLabel(over.id),
            })
          : t('dnd.movedOutside', { block: resolveDndBlockLabel(active.id) }),
      onDragEnd: ({ active, over }) =>
        over
          ? t('dnd.dropped', {
              block: resolveDndBlockLabel(active.id),
              target: resolveDndBlockLabel(over.id),
            })
          : t('dnd.droppedOutside', { block: resolveDndBlockLabel(active.id) }),
      onDragCancel: ({ active }) => t('dnd.cancelled', { block: resolveDndBlockLabel(active.id) }),
    }),
    [resolveDndBlockLabel, t],
  )

  const dndScreenReaderInstructions = useMemo<ScreenReaderInstructions>(
    () => ({ draggable: t('dnd.screenReaderInstructions') }),
    [t],
  )

  // dnd-kit renders its screen-reader instructions + live region into this
  // container. Marking it `data-find-skip` keeps the always-present,
  // visually-hidden SR helper text (which mentions "block") out of the
  // in-page-find scan so it can't inflate match counts (#2943; regression
  // caught by the in-page-find e2e on #2994).
  const [dndA11yContainer] = useState<HTMLDivElement | null>(() => {
    if (typeof document === 'undefined') return null
    const el = document.createElement('div')
    el.setAttribute('data-find-skip', '')
    return el
  })
  useEffect(() => {
    if (!dndA11yContainer) return
    document.body.append(dndA11yContainer)
    return () => {
      dndA11yContainer.remove()
    }
  }, [dndA11yContainer])

  const dndAccessibility = useMemo(
    () => ({
      announcements: dndAnnouncements,
      screenReaderInstructions: dndScreenReaderInstructions,
      ...(dndA11yContainer ? { container: dndA11yContainer } : {}),
    }),
    [dndAnnouncements, dndScreenReaderInstructions, dndA11yContainer],
  )

  // ── Action / resolver bags published via context ────────
  // Memoised so descendants only re-render when callbacks change.
  const { blockActions, blockResolvers } = useBlockTreeContextBags({
    onNavigate: handleNavigate,
    onDelete: remove,
    onIndent: handleIndentById,
    onDedent: handleDedentById,
    onMoveUp: handleMoveUpById,
    onMoveDown: handleMoveDownById,
    onMerge: handleMergeById,
    onToggleTodo: handleToggleTodo,
    onTogglePriority: handleTogglePriority,
    onToggleCollapse: toggleCollapse,
    onShowHistory: handleShowHistory,
    onShowProperties: handleShowProperties,
    onZoomIn: handleZoomIn,
    onSelect: handleSelect,
    onTurnInto: handleTurnInto,
    // `void` adapts the async handler to the bag's `(blockId) => void` shape.
    onDuplicate: (blockId: string) => void handleDuplicate(blockId),
    // Fix 6 — bulk-delete the active multi-selection from the long-press /
    // right-click context menu (single IPC + undo toast). `void` adapts the
    // async handler to the bag's `() => void` shape.
    onBatchDelete: () => void handleBatchDelete(),
    resolveBlockTitle: resolve.resolveBlockTitle,
    resolveTagName: resolve.resolveTagName,
    resolveBlockStatus: resolve.resolveBlockStatus,
    resolveTagStatus: resolve.resolveTagStatus,
  })

  // ── Batch attachment counts ─────────────────────────────
  // Single IPC that publishes block_id → count to all SortableBlock
  // descendants, replacing N per-row `listAttachments` IPCs for the badge
  // count. #1268 — scoped to the viewport window (`windowedBlocks`) rather
  // than the whole page; a row scrolled into view enters the window and its
  // attachment counts/list resolve then, instead of fetching for all N rows
  // up front on a large page.
  const windowedBlockIds = useMemo(
    () => windowedBlocksWithFocus.map((b) => b.id),
    [windowedBlocksWithFocus],
  )

  // ── Batch block properties (#2270) ──────────────────────────────────
  // Single `getBatchProperties` IPC published to every StaticBlock descendant
  // so an image block reads image_width/alignment/caption from this shared
  // page-wide batch instead of firing its own per-block `getBatchProperties`
  // (N+1 on gallery / journal week/month views). Mirrors the
  // BatchAttachmentsProvider mount above (windowed to the viewport). The
  // invalidation key mirrors AgendaResults: bump the provider's refetch on
  // every `block:properties-changed` event AND on space switch, so an edit to
  // an image property re-syncs the rendered width/alignment/caption.
  //
  // #2905 — SCOPED, not the app-global counter: journal week/month views
  // mount one BlockTree per day, all sharing the same
  // `block:properties-changed` event stream. The global counter
  // (`useBlockPropertyEvents`) bumps for ANY block's property edit anywhere,
  // so it used to re-issue every mounted tree's `getBatchProperties` IPC for
  // an edit that may touch none of them. `useScopedBlockPropertyEvents` only
  // bumps THIS tree's key when the changed block is owned by this tree's own
  // page store (`storeOwnsBlock`, the same ownership gate used by the
  // document-level listener guards) — a payload-less/bulk event still falls
  // back to a blanket bump, so no invalidation this tree might care about is
  // ever dropped.
  const ownsBlockForPropertyEvents = useCallback(
    (blockId: string) => storeOwnsBlock(pageStore, blockId),
    [pageStore],
  )
  const { invalidationKey: propertyInvalidationKey } = useScopedBlockPropertyEvents({
    ownsBlock: ownsBlockForPropertyEvents,
  })
  const batchPropertiesInvalidationKey = `${propertyInvalidationKey}|${currentSpaceId ?? ''}`

  if (loading) {
    return (
      // #2939 — keep the (headless) editor host mounted across load toggles so
      // the roving editor instance persists like it did when constructed
      // eagerly. `editorSurface` is published once the runtime chunk loads.
      <EditorSurfaceContext.Provider value={editorSurface}>
        {editorHost}
        <div
          className="block-tree-loading space-y-3 p-2"
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level skeleton container; native <output> is display:inline and would collapse the space-y-3 vertical stacking of the skeleton rows
          role="status"
          aria-busy="true"
          aria-label={t('blockTree.loadingLabel')}
        >
          <Skeleton className="h-6 w-full rounded" />
          <Skeleton className="h-6 w-5/6 rounded" />
          <Skeleton className="h-6 w-4/6 rounded" />
          <Skeleton className="h-6 w-full rounded" />
        </div>
      </EditorSurfaceContext.Provider>
    )
  }

  return (
    <EditorSurfaceContext.Provider value={editorSurface}>
      {editorHost}
      <BatchAttachmentsProvider blockIds={windowedBlockIds}>
        <BatchPropertiesProvider
          blockIds={windowedBlockIds}
          invalidationKey={batchPropertiesInvalidationKey}
        >
          <BlockZoomBar
            breadcrumbs={zoomBreadcrumb}
            onNavigate={handleZoomIn}
            onZoomToRoot={zoomToRoot}
          />
          {/* #1258 — the backend caps a page at PAGE_SUBTREE_MAX_BLOCKS and used
          to drop the excess silently. A non-blocking notice (matches the
          SearchPanel capped-notice pattern) tells the user the page is only
          partially displayed. */}
          {truncatedTotal != null && (
            <div
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block-level notice card (border/padding/rounded); <output> is inline-level and would break the boxed layout
              role="status"
              data-testid="page-truncated-notice"
              className="mb-2 rounded-lg border border-alert-warning-border bg-alert-warning p-3 text-sm text-alert-warning-foreground"
            >
              {t('blockTree.truncatedNotice', { shown: blocks.length, total: truncatedTotal })}
            </div>
          )}
          <BlockBatchActionMenu
            selectedBlockIds={selectedBlockIds}
            batchInProgress={batchInProgress}
            batchDeleteConfirm={batchDeleteConfirm}
            onBatchSetTodo={handleBatchSetTodo}
            onBatchSetPriority={handleBatchSetPriority}
            onBatchDelete={handleBatchDelete}
            onSetBatchDeleteConfirm={setBatchDeleteConfirm}
            onClearSelection={clearSelected}
          />
          <DndContext
            sensors={dnd.sensors}
            collisionDetection={closestCenter}
            measuring={DND_MEASURING}
            // #752 — disable dnd-kit's built-in edge auto-scroll: `useBlockDnD`
            // already runs the custom `useAutoScrollOnDrag` RAF loop against the
            // #main-content container. Running both is additive (jank), and the
            // built-in one ignores `prefers-reduced-motion`, defeating the custom
            // loop's reduced-motion opt-out.
            autoScroll={false}
            onDragStart={dnd.handleDragStart}
            onDragMove={dnd.handleDragMove}
            onDragOver={dnd.handleDragOver}
            onDragEnd={dnd.handleDragEnd}
            onDragCancel={dnd.handleDragCancel}
            accessibility={dndAccessibility}
          >
            <BlockActionsProvider value={blockActions}>
              <BlockResolversProvider value={blockResolvers}>
                <BlockListRenderer
                  visibleItems={dnd.visibleItems}
                  blocks={blocks}
                  loading={loading}
                  rootParentId={rootParentId}
                  isZoomed={zoomedBlockId !== null}
                  onExitZoom={zoomToRoot}
                  focusedBlockId={focusedBlockId}
                  selectedBlockIds={selectedBlockIds}
                  projected={dnd.projected}
                  activeId={dnd.activeId}
                  overId={dnd.overId}
                  dropAfter={dnd.dropAfter}
                  viewport={viewport}
                  rovingEditor={rovingEditor}
                  onContainerPointerDown={handleContainerPointerDown}
                  hasChildrenSet={hasChildrenSet}
                  collapsedIds={collapsedIds}
                  hiddenMountCount={hiddenMountCount}
                  onExpandMount={expandMountLimit}
                />
              </BlockResolversProvider>
            </BlockActionsProvider>
            <BlockDndOverlay
              activeBlock={activeBlock}
              projected={dnd.projected}
              activeId={dnd.activeId}
              count={draggingCount}
            />
          </DndContext>

          {/* Floating date picker for /DATE slash command */}
          {datePickerOpen && (
            <BlockDatePicker
              onSelect={(day) => day && handleDatePick(day)}
              onClose={() => setDatePickerOpen(false)}
            />
          )}

          {/* Floating template picker for /TEMPLATE slash command */}
          {templatePickerOpen && (
            <TemplatePicker
              templatePages={templatePages}
              onSelect={handleTemplateSelect}
              onClose={() => setTemplatePickerOpen(false)}
            />
          )}

          {/* Block-level dialog mounts: query builder (#215), emoji picker
          (#286), block-history sheet, property drawer (#2930). */}
          <BlockTreeDialogs
            queryBuilderOpen={queryBuilderOpen}
            setQueryBuilderOpen={setQueryBuilderOpen}
            handleQuerySave={handleQuerySave}
            emojiPickerOpen={emojiPickerOpen}
            setEmojiPickerOpen={setEmojiPickerOpen}
            handleEmojiSelect={handleEmojiSelect}
            historyBlockId={historyBlockId}
            setHistoryBlockId={setHistoryBlockId}
            propertyDrawerBlockId={propertyDrawerBlockId}
            setPropertyDrawerBlockId={setPropertyDrawerBlockId}
          />
        </BatchPropertiesProvider>
      </BatchAttachmentsProvider>
    </EditorSurfaceContext.Provider>
  )
}
