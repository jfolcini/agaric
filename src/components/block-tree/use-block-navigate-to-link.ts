/**
 * useBlockNavigateToLink — owns the `[[ULID]]` link-target navigation
 * dispatch.
 *
 * Hoists both the `handleNavigate` callback and the `handleNavigateRef`
 * indirection (which `useRovingEditor.onNavigate` captures before the
 * handler exists) out of BlockTree. The hook is called BEFORE
 * `useRovingEditor` so the returned ref is available to wire into the
 * editor; the handler itself reads `rovingEditorRef.current` and
 * `handleFlushRef.current` lazily, both of which are populated by
 * BlockTree later in the render. Extracted for.
 */

import type { TFunction } from 'i18next'
import type { RefObject } from 'react'
import { useCallback, useRef } from 'react'

import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { unwrap } from '@/lib/app-error'
import { commands } from '@/lib/bindings'
import type { NavigateToPageFn } from '@/lib/block-events'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { toSpaceScope } from '@/lib/space-scope'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

type TFn = TFunction

export interface UseBlockNavigateToLinkParams {
  /** Ref to the editor handle. May be null on first render — populated
   *  by BlockTree after `useRovingEditor` is created. */
  rovingEditorRef: RefObject<RovingEditorHandle | null>
  /** Ref to the flush callback. Defined later in BlockTree — accessed
   *  via ref so this hook can run before `handleFlush` exists. */
  handleFlushRef: RefObject<() => string | null>
  load: () => Promise<void>
  setFocused: (id: string | null) => void
  rootParentId: string | null
  onNavigateToPage: NavigateToPageFn | undefined
  t: TFn
}

export interface UseBlockNavigateToLinkReturn {
  /** Promise-returning navigation handler. */
  handleNavigate: (targetId: string) => Promise<void>
  /**
   * Stable ref pointing at the latest `handleNavigate` — wire this
   * into `useRovingEditor.onNavigate` to break the circular dep.
   *
   * **Contract (FE-L-9):** consumers MUST always read
   * `handleNavigateRef.current` at call time. Never cache the dereferenced
   * function — `handleNavigate` is recreated on every render (its
   * `useCallback` deps change), and a cached copy will silently invoke
   * stale closures over `rovingEditorRef`, `load`, `setFocused`, etc.
   * If a stable invocable is needed (e.g. for an event listener that
   * only registers once), wrap it as
   * `(id: string) => handleNavigateRef.current(id)` at the registration
   * site rather than capturing the ref's current value.
   */
  handleNavigateRef: RefObject<(id: string) => void>
}

export function useBlockNavigateToLink({
  rovingEditorRef,
  handleFlushRef,
  load,
  setFocused,
  rootParentId,
  onNavigateToPage,
  t,
}: UseBlockNavigateToLinkParams): UseBlockNavigateToLinkReturn {
  const handleNavigateRef = useRef<(id: string) => void>(() => {})

  const handleNavigate = useCallback(
    async (targetId: string): Promise<void> => {
      // Flush current editor state before navigating
      handleFlushRef.current()
      try {
        const targetBlock = unwrap(await commands.getBlock(targetId))

        // #3306 — space-scope the navigate path.
        //
        // `commands.getBlock` delegates to `get_active_block_inner`, whose SQL
        // carries a soft-delete predicate and NOTHING else: `SELECT … FROM
        // blocks WHERE id = ? AND deleted_at IS NULL`. It happily returns a row
        // that lives in another space. Its sibling `batch_resolve` takes a
        // mandatory `SpaceScope` and is documented as the policy enforcement
        // point; the single-row path had no equivalent, so a `[[ULID]]` whose
        // target had since been moved to another space (PageHeader's "Move to
        // space" is the mainstream way that happens) would fetch the foreign
        // row and write its title into the ACTIVE space's resolve slice —
        // `useResolveStore.set` keys by `keyFor(activeSpaceId(), id)`. The
        // subsequent `loadPageSubtree` did reject with PageNotInSpace and the
        // #2810 heal bounced the user back, but the foreign title stayed
        // readable on the chip in this space for the rest of the session. The
        // locked-in policy is "no live links between spaces, ever".
        //
        // So: ask the space-scoped resolver whether the target belongs to the
        // active space BEFORE the cache write and before any navigation. A
        // foreign target simply does not come back (`b.space_id = ?`), which is
        // the same drop-out the picker paths already rely on. Fail closed when
        // the space store has not hydrated — mirrors the resolve store's
        // FE-H-22 policy, since an unverifiable target must not be trusted.
        const spaceId = useSpaceStore.getState().currentSpaceId
        const inActiveSpace =
          spaceId != null &&
          unwrap(await commands.batchResolve([targetId], toSpaceScope(spaceId))).some(
            (r) => r.id === targetId,
          )
        if (!inActiveSpace) {
          logger.warn(
            'BlockTree',
            'Link target is not in the active space — refusing to navigate',
            {
              targetId,
              spaceId,
            },
          )
          // Deliberately NOT `useResolveStore.set(...)`: caching the fetched
          // title here is the leak. The message matches the one the page-load
          // heal already shows for this case, and shares its toast id so the
          // two paths collapse into a single toast.
          notify.info(t('error.pageNotInCurrentSpace'), { id: 'page-not-in-space' })
          return
        }

        // Populate cache with the fetched block info
        useResolveStore
          .getState()
          .set(
            targetId,
            targetBlock.content?.slice(0, 60) || `[[${targetId.slice(0, 8)}...]]`,
            targetBlock.deleted_at !== null,
          )

        // If target is a page, navigate to it in the page editor
        if (targetBlock.block_type === 'page') {
          onNavigateToPage?.(targetId, targetBlock.content ?? 'Untitled')
          return
        }

        // If target's parent differs from our tree's parent, navigate to the parent page
        if (targetBlock.parent_id && targetBlock.parent_id !== rootParentId) {
          // Fetch the parent to get the actual page title (not the target block's content)
          try {
            const parentBlock = unwrap(await commands.getBlock(targetBlock.parent_id))
            onNavigateToPage?.(targetBlock.parent_id, parentBlock.content ?? 'Untitled', targetId)
          } catch (err) {
            logger.warn(
              'BlockTree',
              'Failed to fetch parent block title for navigation',
              {
                parentId: targetBlock.parent_id,
              },
              err,
            )
            onNavigateToPage?.(targetBlock.parent_id, 'Untitled', targetId)
          }
          return
        }

        // Same tree — navigate locally
        await load()
        setFocused(targetId)
        rovingEditorRef.current?.mount(targetId, targetBlock.content ?? '')
      } catch (err) {
        logger.error(
          'BlockTree',
          'Failed to navigate to block link target',
          {
            targetId,
          },
          err,
        )
        notify.error(t('blockTree.linkTargetNotFound'))
      }
    },
    [handleFlushRef, rovingEditorRef, load, setFocused, rootParentId, onNavigateToPage, t],
  )

  // Keep ref in sync with the latest handleNavigate so consumers
  // captured at first render still call into the up-to-date callback.
  handleNavigateRef.current = handleNavigate

  return { handleNavigate, handleNavigateRef }
}
