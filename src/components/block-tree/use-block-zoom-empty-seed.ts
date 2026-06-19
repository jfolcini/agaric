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
 * Idempotent per zoom root (a ref) so it fires exactly once per zoom-into —
 * re-zooming the same now-non-empty block is a no-op, and zooming a different
 * leaf re-arms it.
 */

import type { TFunction } from 'i18next'
import { useEffect, useRef } from 'react'

import { notify } from '@/lib/notify'

import { logger } from '../../lib/logger'
import { createBlock } from '../../lib/tauri'
import type { FlatBlock } from '../../lib/tree-utils'
import { getDragDescendants } from '../../lib/tree-utils'
import { useBlockStore } from '../../stores/blocks'
import { type PageBlockState, usePageBlockStoreApi } from '../../stores/page-blocks'

export interface UseBlockZoomEmptySeedParams {
  /** When false the effect is a no-op (e.g. weekly/monthly journal views). */
  enabled: boolean
  /** Whether the page is currently loading. The effect bails until load completes. */
  loading: boolean
  /** The currently zoomed-in block id, or null when viewing the page root. */
  zoomedBlockId: string | null
  /** Page store API — for the seed splice and the post-async same-zoom guard. */
  pageStore: ReturnType<typeof usePageBlockStoreApi>
  /** i18n translator — used for the failure toast key. */
  t: TFunction
}

/** Whether `zoomRootId` exists in `blocks` and has at least one descendant. */
function zoomRootHasChildren(blocks: FlatBlock[], zoomRootId: string): boolean {
  if (!blocks.some((b) => b.id === zoomRootId)) return false
  return getDragDescendants(blocks, zoomRootId).size > 0
}

/**
 * Runs the #922 empty-zoom seed effect. No return value; this hook exists
 * purely to encapsulate the effect + its idempotency ref.
 */
export function useBlockZoomEmptySeed({
  enabled,
  loading,
  zoomedBlockId,
  pageStore,
  t,
}: UseBlockZoomEmptySeedParams): void {
  const seededForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (loading || zoomedBlockId == null) return
    if (seededForRef.current === zoomedBlockId) return

    const state = pageStore.getState()
    const zoomRoot = state.blocksById.get(zoomedBlockId)
    // The zoom root must exist and actually be a leaf. A non-leaf zoom already
    // has a usable view, so leave it alone.
    if (!zoomRoot) return
    if (zoomRootHasChildren(state.blocks, zoomedBlockId)) return

    seededForRef.current = zoomedBlockId

    createBlock({ blockType: 'content', content: '', parentId: zoomedBlockId })
      .then((result) => {
        const current = pageStore.getState()
        // Bail if the user zoomed elsewhere or the zoom root vanished while the
        // create IPC was in flight.
        const root = current.blocksById.get(zoomedBlockId)
        if (!root) return
        // A child landed mid-flight (a sync reload, a racing create) — the view
        // is already usable; don't add a second empty block.
        if (zoomRootHasChildren(current.blocks, zoomedBlockId)) return
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
        useBlockStore.setState({ focusedBlockId: result.id })
      })
      .catch((err: unknown) => {
        logger.error(
          'BlockTree',
          'Failed to seed first block under zoom root',
          { zoomedBlockId },
          err,
        )
        notify.error(t('blockTree.createFirstBlockFailed'))
        // #1566 — reset the idempotency ref so the guard no longer short-
        // circuits and a later re-render retries. Without this the user is
        // stranded on a permanently blank zoom pane (the create failed, but the
        // ref still claims this zoom root was seeded, so no child is ever made).
        // Reset only if the ref still points at THIS zoom root (zooming
        // elsewhere mid-flight may have re-armed it; clobbering that would let a
        // stale retry fire there). A bare ref write does not trigger a re-render,
        // so this cannot spin a hot loop — the retry only runs when React next
        // re-renders for some other reason.
        if (seededForRef.current === zoomedBlockId) {
          seededForRef.current = null
        }
      })
  }, [enabled, loading, zoomedBlockId, pageStore, t])
}
