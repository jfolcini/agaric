/**
 * useBlockAutoCreateFirstBlock — H-9 auto-create-empty-block effect.
 *
 * When a page loads with no child blocks, auto-create an empty content
 * block so the user can immediately start typing. Uses an internal ref
 * to prevent double-creation on the same page (idempotent per
 * `rootParentId`).
 *
 * Extracted from BlockTree.tsx as part of the Phase 3 structural carve-out.
 * The body is identical to the previous inline `useEffect`; the only
 * change is that the per-page idempotency ref now lives next to the
 * effect rather than at the top of BlockTree's render.
 */

import type { TFunction } from 'i18next'
import { useEffect, useRef } from 'react'

import { notify } from '@/lib/notify'

import { logger } from '../../lib/logger'
import { createBlock } from '../../lib/tauri'
import { useBlockStore } from '../../stores/blocks'
import type { usePageBlockStoreApi } from '../../stores/page-blocks'

type TFn = TFunction

export interface UseBlockAutoCreateFirstBlockParams {
  /** When false, the effect is a no-op (e.g. weekly/monthly journal views). */
  enabled: boolean
  /** Whether the page is currently loading. The effect bails until load completes. */
  loading: boolean
  /** Count of blocks currently in the page store. Effect only fires at 0. */
  blocksLength: number
  /** Current page root parent. Effect bails until this is non-null. */
  rootParentId: string | null
  /** Page store API — for the optimistic `setState` and the post-async same-page guard. */
  pageStore: ReturnType<typeof usePageBlockStoreApi>
  /** i18n translator — used for the failure toast key. */
  t: TFn
}

/**
 * Runs the H-9 auto-create-first-block effect. No return value; this hook
 * exists purely to encapsulate the effect + its idempotency ref.
 */
export function useBlockAutoCreateFirstBlock({
  enabled,
  loading,
  blocksLength,
  rootParentId,
  pageStore,
  t,
}: UseBlockAutoCreateFirstBlockParams): void {
  const autoCreatedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (loading || blocksLength > 0 || !rootParentId) return
    if (autoCreatedForRef.current === rootParentId) return
    autoCreatedForRef.current = rootParentId

    createBlock({ blockType: 'content', content: '', parentId: rootParentId })
      .then((result) => {
        const current = pageStore.getState()
        // Only apply if we're still on the same page
        if (current.rootParentId !== rootParentId) return
        // #752 — the `setState` below is a WHOLESALE replace of `blocks`.
        // If any block appeared while the create IPC was in flight (the
        // user typed Enter on a freshly mounted editor, a sync reload
        // landed), writing `[result]` would clobber it. Skip the store
        // write instead — the created block is still in the database and
        // surfaces on the next load; an extra empty block on a no-longer-
        // empty page is harmless, a vanished user block is not.
        if (current.blocks.length > 0) return
        // Defensive guard: a malformed result (missing id) must never reach the
        // store, because downstream renderers key by block.id and would emit
        // "Each child in a list should have a unique key" warnings for the
        // transient render before the next refetch. In production this guard
        // never fires; it catches test-mock leaks and any future regression.
        if (!result?.id) {
          logger.warn('BlockTree', 'auto-create returned result without id; skipping store write', {
            rootParentId: rootParentId ?? '',
          })
          return
        }
        pageStore.setState({
          blocks: [
            {
              ...result,
              depth: 0,
            },
          ],
        })
        useBlockStore.setState({ focusedBlockId: result.id })
      })
      .catch((err: unknown) => {
        logger.error(
          'BlockTree',
          'Failed to auto-create first block',
          {
            rootParentId: rootParentId ?? '',
          },
          err,
        )
        notify.error(t('blockTree.createFirstBlockFailed'))
        // #1566 — reset the idempotency ref so the guard no longer short-
        // circuits and a later re-render retries. Without this the user is
        // stranded on a permanently blank page (the create failed, but the
        // ref still claims this page was seeded, so no block is ever made).
        // Reset only if the ref still points at THIS page (a page switch
        // mid-flight may have re-armed it for another rootParentId; clobbering
        // that would let a stale retry fire there). A bare ref write does not
        // trigger a re-render, so this cannot spin a hot loop — the retry only
        // runs when React next re-renders for some other reason.
        if (autoCreatedForRef.current === rootParentId) {
          autoCreatedForRef.current = null
        }
      })
  }, [enabled, loading, blocksLength, rootParentId, t, pageStore])
}
