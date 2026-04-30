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
 * BlockTree later in the render. Extracted for MAINT-128.
 */

import type { RefObject } from 'react'
import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import type { RovingEditorHandle } from '../editor/use-roving-editor'
import type { NavigateToPageFn } from '../lib/block-events'
import { logger } from '../lib/logger'
import { getBlock } from '../lib/tauri'
import { useResolveStore } from '../stores/resolve'

// biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
type TFn = (...args: any[]) => any

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
  /** Stable ref pointing at the latest `handleNavigate` — wire this
   *  into `useRovingEditor.onNavigate` to break the circular dep. */
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
        const targetBlock = await getBlock(targetId)
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
            const parentBlock = await getBlock(targetBlock.parent_id)
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
        toast.error(t('blockTree.linkTargetNotFound'))
      }
    },
    [handleFlushRef, rovingEditorRef, load, setFocused, rootParentId, onNavigateToPage, t],
  )

  // Keep ref in sync with the latest handleNavigate so consumers
  // captured at first render still call into the up-to-date callback.
  handleNavigateRef.current = handleNavigate

  return { handleNavigate, handleNavigateRef }
}
