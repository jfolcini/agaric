/**
 * useBlockZoomEmptySeed — #922 seed-a-child-under-an-empty-zoom-root effect.
 *
 * Companion to the H-9 auto-create-first-block effect
 * (`useBlockAutoCreateFirstBlock`), but for a DIFFERENT empty surface: a
 * zoomed-in LEAF block.
 *
 * Since #922 dropped the `hasChildren` gate on keyboard zoom-in, any block —
 * leaf or not — can be zoomed. A zoomed leaf shows an EMPTY view, because the
 * zoomed view (`useBlockZoom.zoomedVisible`) renders the zoom root's
 * DESCENDANTS, and a leaf has none. Without a child the user faces a blank pane
 * with nowhere to type.
 *
 * The H-9 effect cannot help here: it only fires when the WHOLE page is empty
 * (`blocksLength === 0`) and does a WHOLESALE `setState({ blocks: [...] })`
 * replace — which would clobber the rest of the page (every block outside the
 * zoom root). So this effect seeds a first child UNDER the zoom root via a
 * NON-wholesale insert: it creates the block through the `createBlock` IPC and
 * splices the returned row into the flat tree right after the zoom root, at
 * `zoomRoot.depth + 1`, leaving the rest of the page untouched.
 *
 * A per-root in-flight guard prevents duplicate creates while still allowing
 * the effect to re-arm when a previously-seeded root becomes a leaf again.
 */

import type { TFunction } from 'i18next'
import { useEffect, useLayoutEffect, useRef } from 'react'

import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import type { FlatBlock } from '@/lib/tree-utils'
import { getDragDescendants } from '@/lib/tree-utils'
import { useBlockStore } from '@/stores/blocks'
import { type PageBlockState, usePageBlockStoreApi } from '@/stores/page-blocks'

export interface UseBlockZoomEmptySeedParams {
  /** When false the effect is a no-op (e.g. weekly/monthly journal views). */
  enabled: boolean
  /** Whether the page is currently loading. The effect bails until load completes. */
  loading: boolean
  /** The currently zoomed-in block id, or null when viewing the page root. */
  zoomedBlockId: string | null
  /** Primitive projection of whether the current zoom root has descendants. */
  zoomRootHasChildren: boolean
  /** Page store API — for the seed splice and post-async root/child guards. */
  pageStore: ReturnType<typeof usePageBlockStoreApi>
  /** i18n translator — used for the failure toast key. */
  t: TFunction
}

/** Whether `zoomRootId` exists in `blocks` and has at least one descendant. */
function hasChildrenInState(blocks: FlatBlock[], zoomRootId: string): boolean {
  if (!blocks.some((b) => b.id === zoomRootId)) return false
  return getDragDescendants(blocks, zoomRootId).size > 0
}

/**
 * Runs the #922 empty-zoom seed effect. No return value; this hook exists
 * purely to encapsulate the effect + its in-flight guard.
 */
export function useBlockZoomEmptySeed({
  enabled,
  loading,
  zoomedBlockId,
  zoomRootHasChildren,
  pageStore,
  t,
}: UseBlockZoomEmptySeedParams): void {
  const inFlightRootsRef = useRef(new Set<string>())
  const currentContextRef = useRef<{
    zoomedBlockId: string | null
    pageStore: ReturnType<typeof usePageBlockStoreApi>
  } | null>(null)

  // Promise continuations must not focus a child in a tree the user has
  // already left (or after this hook unmounts). Publish only committed hook
  // context, and clear it conditionally so an older cleanup cannot erase a
  // newer page/zoom context.
  useLayoutEffect(() => {
    const context = { zoomedBlockId, pageStore }
    currentContextRef.current = context
    return () => {
      if (currentContextRef.current === context) currentContextRef.current = null
    }
  }, [zoomedBlockId, pageStore])

  useEffect(() => {
    if (!enabled) return
    if (loading || zoomedBlockId == null) return
    if (zoomRootHasChildren) return
    if (inFlightRootsRef.current.has(zoomedBlockId)) return

    const state = pageStore.getState()
    const zoomRoot = state.blocksById.get(zoomedBlockId)
    // The zoom root must exist and actually be a leaf. A non-leaf zoom already
    // has a usable view, so leave it alone.
    if (!zoomRoot) return
    if (hasChildrenInState(state.blocks, zoomedBlockId)) return

    inFlightRootsRef.current.add(zoomedBlockId)

    commands
      .createBlock('content', '', zoomedBlockId, null, { kind: 'global' }, null)
      .then(unwrap)
      .then((result) => {
        const current = pageStore.getState()
        // Reconcile into the originating store even if the user zoomed
        // elsewhere, but bail if that store no longer contains the root.
        const root = current.blocksById.get(zoomedBlockId)
        if (!root) return
        // A child landed mid-flight (a sync reload, a racing create) — the view
        // is already usable; don't add a second empty block.
        if (hasChildrenInState(current.blocks, zoomedBlockId)) return
        // Defensive: a malformed result (missing id) must never reach the
        // store — downstream renderers key by block.id.
        if (!result?.id) {
          logger.warn('BlockTree', 'zoom-seed returned result without id; skipping store write', {
            zoomedBlockId,
          })
          return
        }

        // NON-wholesale insert: splice the new child right after the zoom root
        // in the flat array, at `zoomRoot.depth + 1`. Everything else in the
        // page is preserved (unlike H-9's wholesale `setState({ blocks })`).
        const newBlock: FlatBlock = { ...result, depth: root.depth + 1 }
        pageStore.setState((s: PageBlockState) => {
          const rootIdx = s.blocks.findIndex((b) => b.id === zoomedBlockId)
          if (rootIdx < 0) return {}
          const blocks = [...s.blocks]
          blocks.splice(rootIdx + 1, 0, newBlock)
          return { blocks }
        })
        const currentContext = currentContextRef.current
        if (
          currentContext?.zoomedBlockId === zoomedBlockId &&
          currentContext.pageStore === pageStore
        ) {
          useBlockStore.setState({ focusedBlockId: result.id })
        }
      })
      .catch((err: unknown) => {
        logger.error(
          'BlockTree',
          'Failed to seed first block under zoom root',
          { zoomedBlockId },
          err,
        )
        notify.error(t('blockTree.createFirstBlockFailed'))
      })
      .finally(() => {
        // Clear only this request's per-root guard. Other roots may still have
        // creates outstanding. A ref write does not trigger a render, so a
        // failed request retries only on a later state/prop change.
        if (inFlightRootsRef.current.has(zoomedBlockId)) {
          inFlightRootsRef.current.delete(zoomedBlockId)
        }
      })
  }, [enabled, loading, zoomedBlockId, zoomRootHasChildren, pageStore, t])
}
