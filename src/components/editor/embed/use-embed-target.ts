/**
 * `useEmbedTarget` — resolve what an `{{embed ((ULID))}}` token points at
 * (#4550, phase 1).
 *
 * Four outcomes, all of which must RENDER something: the host block's content
 * still holds the token, so a silent disappearance leaves an empty,
 * unexplained row on the host page.
 *
 * | outcome      | when                                                  |
 * |--------------|-------------------------------------------------------|
 * | `loading`    | the two IPCs below are in flight                       |
 * | `ready`      | live target in the active space                        |
 * | `deleted`    | target soft-deleted (`deleted_at IS NOT NULL`)         |
 * | `unresolved` | purged / never existed / **in another space**          |
 *
 * Cross-space collapses into `unresolved` deliberately. `commands.getBlock`
 * delegates to `get_active_block_inner`, whose SQL carries a soft-delete
 * predicate and nothing else — it happily returns a row that lives in another
 * space (#3306). `batch_resolve` is the space-scoped policy enforcement point,
 * so the space check runs through it exactly as `use-block-navigate-to-link`
 * does, and a foreign target simply does not come back. The locked-in policy
 * is "no live links between spaces, ever", and rendering a foreign page's
 * subtree inline would be the loudest possible violation of it. Both cases
 * render the same non-navigating broken chip.
 *
 * Fails closed when the space store has not hydrated, mirroring the resolve
 * store's FE-H-22 policy: an unverifiable target must not be trusted.
 */

import { useEffect, useState } from 'react'

import { commands } from '@/lib/bindings'
import { resolveStoreTitle } from '@/lib/block-title'
import { logger } from '@/lib/logger'
import { toSpaceScope } from '@/lib/space-scope'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

export type EmbedTargetState =
  | { status: 'loading' }
  | {
      status: 'ready'
      /** The page whose store must be mounted to render this target. */
      sourcePageId: string
      /** Display title of that page. */
      sourcePageTitle: string
      /** True when the target IS the page (a `{{embed [[page]]}}`). */
      isPageTarget: boolean
    }
  | { status: 'deleted'; title: string }
  | { status: 'unresolved' }

/**
 * Resolve `targetId` to the page store an embed must mount, plus the page
 * title its breadcrumb leads with. Re-runs when the target changes or when
 * the active space changes.
 */
export function useEmbedTarget(targetId: string): EmbedTargetState {
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  // The resolved value is STAMPED with the (target, space) pair it belongs to,
  // and a stamp mismatch reads as `loading` during render. That is what keeps
  // the effect below from having to `setState({ status: 'loading' })`
  // synchronously on every re-run: switching target or space would otherwise
  // show the PREVIOUS target's subtree for one commit — briefly rendering one
  // block's content under another block's token, and, across a space switch,
  // rendering the outgoing space's content in the incoming one.
  const stamp = `${spaceId ?? ''}\u0000${targetId}`
  const [resolved, setResolved] = useState<{ stamp: string; value: EmbedTargetState }>({
    stamp: '',
    value: { status: 'loading' },
  })

  useEffect(() => {
    let cancelled = false
    const settle = (value: EmbedTargetState): void => {
      if (!cancelled) setResolved({ stamp, value })
    }

    // FE-H-22 — fail closed during pre-bootstrap rather than resolving
    // against an unknown space. Nothing to settle: the stamp mismatch already
    // reads as `loading`.
    if (spaceId == null) {
      return () => {
        cancelled = true
      }
    }

    void (async () => {
      const scope = toSpaceScope(spaceId)
      // The space-scoped half. This is the authority on "does this target
      // exist, in THIS space, and is it alive" — `getBlock` is not.
      let resolvedRows: Awaited<ReturnType<typeof commands.batchResolve>> | null = null
      try {
        resolvedRows = await commands.batchResolve([targetId], scope)
      } catch (err) {
        logger.warn('EmbedContainer', 'embed target resolve failed', { targetId }, err)
        settle({ status: 'unresolved' })
        return
      }
      if (resolvedRows.status !== 'ok') {
        settle({ status: 'unresolved' })
        return
      }
      const row = resolvedRows.data.find((r) => r.id === targetId)
      // Absent → purged, never existed, or in another space. Same render.
      if (!row) {
        settle({ status: 'unresolved' })
        return
      }
      const title = resolveStoreTitle(row.block_type, row.title)
      if (row.deleted) {
        settle({ status: 'deleted', title })
        return
      }

      // Live and in-space: seed the resolve cache (the chip inside a stub and
      // the breadcrumb both read it) and find the owning page.
      useResolveStore.getState().set(targetId, title, false)

      let block: Awaited<ReturnType<typeof commands.getBlock>> | null = null
      try {
        block = await commands.getBlock(targetId)
      } catch (err) {
        logger.warn('EmbedContainer', 'embed target fetch failed', { targetId }, err)
        settle({ status: 'unresolved' })
        return
      }
      if (block.status !== 'ok') {
        settle({ status: 'unresolved' })
        return
      }

      const isPageTarget = block.data.block_type === 'page'
      // A page IS a block here, so a page target is its own store root.
      // `page_id` is the materializer-maintained owning-page column; fall
      // back to `parent_id` for a top-level block on a page that predates it.
      const sourcePageId = isPageTarget ? targetId : (block.data.page_id ?? block.data.parent_id)
      if (sourcePageId == null) {
        settle({ status: 'unresolved' })
        return
      }

      // One extra resolve for the page title the breadcrumb leads with. A
      // page target already has it.
      let sourcePageTitle = title
      if (!isPageTarget) {
        sourcePageTitle = useResolveStore.getState().resolveTitle(sourcePageId)
        try {
          const pageResolved = await commands.batchResolve([sourcePageId], scope)
          if (pageResolved.status === 'ok') {
            const pageRow = pageResolved.data.find((r) => r.id === sourcePageId)
            if (pageRow) {
              sourcePageTitle = resolveStoreTitle(pageRow.block_type, pageRow.title)
              useResolveStore.getState().set(sourcePageId, sourcePageTitle, pageRow.deleted)
            }
          }
        } catch (err) {
          logger.warn('EmbedContainer', 'embed source page resolve failed', { sourcePageId }, err)
        }
      }

      settle({ status: 'ready', sourcePageId, sourcePageTitle, isPageTarget })
    })()

    return () => {
      cancelled = true
    }
  }, [targetId, spaceId, stamp])

  return resolved.stamp === stamp ? resolved.value : { status: 'loading' }
}
