/**
 * useRichContent — the rich-text render concern of StaticBlock.
 *
 * Renders a block's markdown `content` into a memoized React tree of inline
 * chips (block_link, tag_ref, block_ref, external-link) and block nodes,
 * wiring click-to-navigate / tag-click behaviour.
 *
 * The resolve callbacks are captured through stable refs so the expensive
 * `renderRichContent` memo only re-runs when `content` changes — passing a
 * fresh closure each parent render must NOT churn the memo identity. The memo
 * subscribes to the resolve store `version` so it recomputes once a
 * space-switch preload lands (otherwise inline page-link chips stay stuck on
 * the `[[ULID]]` fallback after a switch).
 *
 * `onNavigate` is the only callback that ALSO affects the produced output (it
 * gates a `undefined` vs wrapper-fn branch), so it's listed as an explicit
 * memo dep. The other resolve callbacks feed unconditional wrappers and are
 * intentionally captured via refs — listing them would invalidate the memo on
 * every parent render and defeat the optimization.
 */

import type React from 'react'
import { useMemo, useRef } from 'react'

import { renderRichContent } from '@/components/RichContentRenderer'
import { useTagClickHandler } from '@/hooks/useRichContentCallbacks'
import { useResolveStore } from '@/stores/resolve'

export interface UseRichContentCallbacks {
  /** Called when the user clicks a block-link chip. */
  onNavigate?: ((id: string) => void) | undefined
  /** Resolve a block/page ULID → display title. */
  resolveBlockTitle?: ((id: string) => string) | undefined
  /** Resolve a tag ULID → display name. */
  resolveTagName?: ((id: string) => string) | undefined
  /** Check whether a linked block is active or deleted. */
  resolveBlockStatus?: ((id: string) => 'active' | 'deleted') | undefined
  /** Check whether a referenced tag is active or deleted. */
  resolveTagStatus?: ((id: string) => 'active' | 'deleted') | undefined
}

export function useRichContent(
  content: string,
  {
    onNavigate,
    resolveBlockTitle,
    resolveTagName,
    resolveBlockStatus,
    resolveTagStatus,
  }: UseRichContentCallbacks,
): React.ReactNode {
  // Keep callback refs so the expensive useMemo only re-runs when `content` changes.
  // Callbacks don't affect the rendered output — they only affect click behaviour —
  // so they can safely live in refs that are read at call-time.
  const onNavigateRef = useRef(onNavigate)
  onNavigateRef.current = onNavigate
  const resolveBlockTitleRef = useRef(resolveBlockTitle)
  resolveBlockTitleRef.current = resolveBlockTitle
  const resolveTagNameRef = useRef(resolveTagName)
  resolveTagNameRef.current = resolveTagName
  const resolveBlockStatusRef = useRef(resolveBlockStatus)
  resolveBlockStatusRef.current = resolveBlockStatus
  const resolveTagStatusRef = useRef(resolveTagStatus)
  resolveTagStatusRef.current = resolveTagStatus
  const onTagClick = useTagClickHandler()
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick

  // The resolve callbacks are wired through stable refs (so the memo's
  // identity doesn't churn even when the consumer passes a fresh closure
  // each render), but they read a mutable cache. Subscribe to `version`
  // (bumped by preload / set / clearAllForSpace) so the memo recomputes
  // once the space-switch preload lands — otherwise inline page-link
  // chips stay stuck on the `[[ULID]]` fallback after a switch.
  //
  // `onNavigate` is the only prop that ALSO affects the produced output
  // (it gates a `undefined` vs wrapper-fn branch), so it's listed
  // explicitly. The other resolve props feed unconditional wrappers and
  // are intentionally captured via refs — listing them would invalidate
  // the memo on every parent render and defeat the optimization.
  const resolveVersion = useResolveStore((s) => s.version)
  return useMemo(
    () =>
      content
        ? renderRichContent(content, {
            interactive: true,
            onNavigate: onNavigate ? (id: string) => onNavigateRef.current?.(id) : undefined,
            onTagClick: (id: string) => onTagClickRef.current(id),
            resolveBlockTitle: (id) => resolveBlockTitleRef.current?.(id),
            resolveTagName: (id) => resolveTagNameRef.current?.(id),
            resolveBlockStatus: (id) => resolveBlockStatusRef.current?.(id) ?? 'active',
            resolveTagStatus: (id) => resolveTagStatusRef.current?.(id) ?? 'active',
          })
        : null,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- resolve* callbacks captured via refs (intentional perf optimization — see comment above); resolveVersion drives recomputation on cache updates
    [content, onNavigate, resolveVersion],
  )
}
