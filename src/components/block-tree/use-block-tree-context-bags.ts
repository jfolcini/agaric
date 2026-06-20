/**
 * useBlockTreeContextBags — memoised composition of the per-block action +
 * resolver bags that BlockTree publishes via `BlockActionsProvider` and
 * `BlockResolversProvider`.
 *
 * Both bags are memoised so descendants using `useBlockActions()` /
 * `useBlockResolvers()` only re-render when individual callbacks change
 * (not on unrelated BlockTree state). The memo dep arrays mirror the
 * previous inline implementation 1:1 — adding or removing a callback
 * here MUST also touch the matching dep array.
 *
 * Extracted from BlockTree.tsx as part of the Phase 3 structural carve-out.
 * The hook takes every individual callback as a separate parameter so the
 * memo deps stay observable at the call site (rather than hiding them
 * behind a single object — which would defeat the memo by changing
 * identity on every render).
 */

import { useMemo } from 'react'

import type { BlockActions } from '../../hooks/useBlockActions'
import type { BlockResolvers } from '../../hooks/useBlockResolvers'

export interface UseBlockTreeContextBagsParams {
  // ── Actions ──────────────────────────────────────────────────────
  onNavigate: BlockActions['onNavigate']
  onDelete: BlockActions['onDelete']
  onIndent: BlockActions['onIndent']
  onDedent: BlockActions['onDedent']
  onMoveUp: BlockActions['onMoveUp']
  onMoveDown: BlockActions['onMoveDown']
  onMerge: BlockActions['onMerge']
  onToggleTodo: BlockActions['onToggleTodo']
  onTogglePriority: BlockActions['onTogglePriority']
  onToggleCollapse: BlockActions['onToggleCollapse']
  onShowHistory: BlockActions['onShowHistory']
  onShowProperties: BlockActions['onShowProperties']
  onZoomIn: BlockActions['onZoomIn']
  onSelect: BlockActions['onSelect']
  // #264 — optional so existing callers/tests that don't wire conversion
  // still satisfy the params type.
  onTurnInto?: BlockActions['onTurnInto']
  // #976 (item 13) — optional duplicate-block handler (context menu
  // "Duplicate"); optional so existing callers/tests don't break.
  onDuplicate?: BlockActions['onDuplicate']
  // Fix 6 — optional bulk-delete handler for the multi-selection (context
  // menu "Delete N selected"); optional so existing callers/tests don't break.
  onBatchDelete?: BlockActions['onBatchDelete']

  // ── Resolvers ────────────────────────────────────────────────────
  resolveBlockTitle: BlockResolvers['resolveBlockTitle']
  resolveTagName: BlockResolvers['resolveTagName']
  resolveBlockStatus: BlockResolvers['resolveBlockStatus']
  resolveTagStatus: BlockResolvers['resolveTagStatus']
}

export interface UseBlockTreeContextBagsReturn {
  blockActions: BlockActions
  blockResolvers: BlockResolvers
}

export function useBlockTreeContextBags({
  onNavigate,
  onDelete,
  onIndent,
  onDedent,
  onMoveUp,
  onMoveDown,
  onMerge,
  onToggleTodo,
  onTogglePriority,
  onToggleCollapse,
  onShowHistory,
  onShowProperties,
  onZoomIn,
  onSelect,
  onTurnInto,
  onDuplicate,
  onBatchDelete,
  resolveBlockTitle,
  resolveTagName,
  resolveBlockStatus,
  resolveTagStatus,
}: UseBlockTreeContextBagsParams): UseBlockTreeContextBagsReturn {
  const blockActions = useMemo<BlockActions>(
    () => ({
      onNavigate,
      onDelete,
      onIndent,
      onDedent,
      onMoveUp,
      onMoveDown,
      onMerge,
      onToggleTodo,
      onTogglePriority,
      onToggleCollapse,
      onShowHistory,
      onShowProperties,
      onZoomIn,
      onSelect,
      onTurnInto,
      onDuplicate,
      onBatchDelete,
    }),
    [
      onNavigate,
      onDelete,
      onIndent,
      onDedent,
      onMoveUp,
      onMoveDown,
      onMerge,
      onToggleTodo,
      onTogglePriority,
      onToggleCollapse,
      onShowHistory,
      onShowProperties,
      onZoomIn,
      onSelect,
      onTurnInto,
      onDuplicate,
      onBatchDelete,
    ],
  )

  const blockResolvers = useMemo<BlockResolvers>(
    () => ({
      resolveBlockTitle,
      resolveTagName,
      resolveBlockStatus,
      resolveTagStatus,
    }),
    [resolveBlockTitle, resolveTagName, resolveBlockStatus, resolveTagStatus],
  )

  return { blockActions, blockResolvers }
}
