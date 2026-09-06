/**
 * BlockDndOverlay — drag overlay marker for the active dragged block.
 *
 * Renders:
 *   - An SR-only live region announcing the projected drop depth
 *   - A low-opacity GHOST of the dragged row (#923 finding 4): the block's
 *     rendered content at the projected indent in a translucent rounded
 *     container, so the drag reads like Notion/Logseq's translucent row ghost
 *     rather than a bare pill. A short drop-settle animation plays when the
 *     row lands (respecting `prefers-reduced-motion`).
 *
 * Extracted from BlockTree.tsx for file organization (F-22).
 */

import { type DropAnimation, DragOverlay } from '@dnd-kit/core'
import type React from 'react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { renderRichContent } from '@/components/RichContentRenderer'
import { shouldReduceMotion } from '@/hooks/useMotionPreference'
import { useRichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import { useResolveStore } from '@/stores/resolve'

interface BlockDndOverlayProps {
  activeBlock: { content?: string | null } | null
  projected: { depth: number } | null
  activeId: string | null
  /** Number of blocks being dragged (active block + its descendant subtree). */
  count?: number
}

/**
 * #923 — short drop-settle animation so the ghost eases into its landing slot
 * instead of vanishing. Suppressed under reduced motion (duration 0 = no
 * animated settle), matching the rest of the DnD motion.
 */
function dropSettleAnimation(): DropAnimation {
  return {
    duration: shouldReduceMotion() ? 0 : 180,
    easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)',
  }
}

export function BlockDndOverlay({
  activeBlock,
  projected,
  activeId,
  count = 1,
}: BlockDndOverlayProps): React.ReactElement {
  const { t } = useTranslation()
  const { resolveBlockTitle, resolveBlockStatus, resolveTagName, resolveTagStatus } =
    useRichContentCallbacks()
  const isSubtree = count > 1
  const depth = projected?.depth ?? 0

  // This component re-renders on every pointer move for the length of a drag,
  // so the ghost is memoized on the content: `renderRichContent`'s markdown
  // parse is LRU-cached but the React element tree it builds is not.
  // `resolveVersion` is the recompute trigger — the resolve callbacks are
  // stable identities reading a mutable cache ref, so nothing else signals
  // that a `[[ULID]]` now resolves to a title (see `BlockListItem`).
  const resolveVersion = useResolveStore((s) => s.version)
  const content = activeBlock?.content?.trim() ?? ''
  const ghost = useMemo(
    () =>
      content
        ? renderRichContent(content, {
            // The ghost is `aria-hidden` + `pointer-events-none`; inert chips
            // keep it a picture of the row rather than a second click target.
            interactive: false,
            inline: true,
            resolveBlockTitle,
            resolveBlockStatus,
            resolveTagName,
            resolveTagStatus,
          })
        : // An empty block still needs a non-collapsing ghost box.
          '\u00A0',
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolveVersion is intentionally load-bearing (see above); the callbacks are listed so a future non-stable identity surfaces as a recompute rather than stale output.
    [
      content,
      resolveBlockTitle,
      resolveBlockStatus,
      resolveTagName,
      resolveTagStatus,
      resolveVersion,
    ],
  )

  return (
    <>
      {/* SR announcement for DnD projected drop position + subtree size */}
      {activeId &&
        projected && (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- intentional SR-only live region (aria-live/atomic); native <output> has implicit aria-live differences and an "Output" semantic role
          <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {isSubtree
              ? t('blockTree.dnd.movingSubtree', { count, depth: projected.depth })
              : t('blockTree.dnd.moving', { depth: projected.depth })}
          </div>
        )}
      {/* Drag overlay: a translucent ghost of the dragged row follows the
          cursor at the projected indent (Notion/Logseq style). For a subtree
          drag we add a small count badge so the user knows how much is moving
          (R8 #407). A short drop-settle animation eases the ghost into place. */}
      <DragOverlay dropAnimation={dropSettleAnimation()}>
        {activeBlock ? (
          <div
            className="sortable-block-overlay pointer-events-none"
            data-testid="sortable-block-overlay"
            aria-hidden="true"
            style={{ paddingLeft: `calc(var(--indent-width) * ${depth})` }}
          >
            <div className="relative max-w-md truncate rounded-md border bg-card px-3 py-1.5 text-sm opacity-70 shadow-(--shadow-overlay)">
              {ghost}
              {isSubtree && (
                <span
                  className="absolute -top-2 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground shadow"
                  data-testid="sortable-block-overlay-count"
                >
                  {count}
                </span>
              )}
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </>
  )
}
