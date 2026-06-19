/**
 * BlockContextMenu — floating context menu for mobile long-press / desktop right-click.
 *
 * Renders at an absolute screen position via a React portal so it is never
 * clipped by overflow containers. Provides quick access to block actions
 * that are otherwise only available on hover (delete, indent, dedent) plus
 * task-state and priority toggles.
 *
 * Closes on: action selected, click outside, or Escape.
 */

import { autoUpdate, computePosition, flip, offset, shift, size } from '@floating-ui/dom'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  CopyPlus,
  ExternalLink,
  Link2,
  Merge,
  MoveDown,
  MoveUp,
  MoveVertical,
  Replace,
  Settings2,
  Signal,
  Trash2,
  ZoomIn,
} from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import type { BlockTypeToken } from '@/lib/block-type-convert'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { openUrl } from '@/lib/open-url'
import { TURN_INTO_OPTIONS, turnIntoTypeKey } from '@/lib/slash-commands'
import { cn } from '@/lib/utils'
import { useBlockStore } from '@/stores/blocks'

import {
  getPriorityLabel,
  getTodoLabel,
  priorityHint,
  shortcutHint,
} from './block-context-menu/hints'
import { renderItem as renderMenuItem } from './block-context-menu/menu-row'
import type { BlockContextMenuProps, MenuItem } from './block-context-menu/types'

// Re-export the public type from its leaf module so external code keeps
// importing it from `@/components/editor/BlockContextMenu` unchanged.
export type { BlockContextMenuProps } from './block-context-menu/types'

export function BlockContextMenu({
  blockId,
  position,
  onClose,
  triggerRef,
  actions,
  hasChildren,
  isCollapsed,
  todoState,
  priority,
  dueDate: _dueDate,
  linkUrl,
  pageRefId,
  activeBlockType,
  selectedBlockIds: selectedBlockIdsProp,
}: BlockContextMenuProps): React.ReactElement {
  const { t } = useTranslation()

  // A2 (#1020) — destructure the action bag once. Each entry is optional; a
  // missing key gates its menu item off (the conditional-group behaviour).
  const {
    onDelete,
    onIndent,
    onDedent,
    onToggleTodo,
    onTogglePriority,
    onToggleCollapse,
    onMoveUp,
    onMoveDown,
    onMerge,
    onShowHistory,
    onShowProperties,
    onZoomIn,
    onTurnInto,
    onDuplicate,
    onBatchDelete,
  } = actions

  // #1018 — subscribe to the global multi-selection HERE (the menu is the only
  // consumer and only mounts while open) instead of in every `SortableBlock`
  // row. This is a LIVE reactive read, so it preserves the Fix 6 correctness:
  // when the menu is open, growing the selection (e.g. the 2nd selected block)
  // re-renders the menu and bulk mode engages — no stale `getState()` snapshot.
  // `selectedBlockIds` stays a STATE prop (not an action in the bag); an
  // explicit prop (tests) overrides the store read.
  const selectedBlockIdsFromStore = useBlockStore((s) => s.selectedBlockIds)
  const selectedBlockIds = selectedBlockIdsProp ?? selectedBlockIdsFromStore
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // #264 — the "Turn into" group is collapsed by default; expanding reveals
  // the block-type options inline (no nested floating popover, so the existing
  // single-list keyboard navigation keeps working).
  const [turnIntoOpen, setTurnIntoOpen] = useState(false)
  // #1003 — stable id linking the "Turn into" toggle (`aria-controls`) to the
  // inline-expanded options group, so screen readers announce the relationship.
  const turnIntoGroupId = useId()
  // #1109 — the low-frequency block-ops (Duplicate / Merge / Move up / Move
  // down) are collapsed behind a single "Move & arrange" toggle, mirroring the
  // "Turn into" disclosure machinery above. Collapsed by default so the menu
  // opens compact; expanding reveals the ops inline (no nested popover, so the
  // single-list keyboard navigation keeps working).
  const [moveArrangeOpen, setMoveArrangeOpen] = useState(false)
  // #1109 — stable id linking the "Move & arrange" toggle (`aria-controls`) to
  // its inline-expanded options group, announced to screen readers.
  const moveArrangeGroupId = useId()

  const handleCloseWithFocus = useCallback(() => {
    // If the trigger element has been removed from the DOM during the menu's
    // lifetime (e.g. block deleted via the menu itself, or via remote sync),
    // `triggerRef.current.focus()` no-ops silently and focus drops to <body>.
    // Fall back to the block's gutter button (marked with
    // `data-context-trigger="true"`) so keyboard users keep a sane focus
    // target near where the action took place. The marker is intentionally
    // narrower than `[role="button"]`, which would also match inline date
    // chips, property chips, etc.
    const fallback = document.querySelector<HTMLElement>(
      `[data-block-id="${blockId}"] [data-context-trigger="true"]`,
    )
    ;(triggerRef?.current ?? fallback)?.focus()
    onClose()
  }, [triggerRef, blockId, onClose])

  // ── Close on click outside ───────────────────────────────────────
  // Defer registration by one animation frame so the same pointerdown
  // event that opened the menu does not immediately close it (BUG-2 /
  // mirrors `suggestion-renderer.ts` and `BlockPropertyEditor.tsx`).
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        handleCloseWithFocus()
      }
    }
    let frameId: number | null = requestAnimationFrame(() => {
      frameId = null
      // Use pointerdown to catch both mouse and touch
      document.addEventListener('pointerdown', handlePointerDown, true)
    })
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
      document.removeEventListener('pointerdown', handlePointerDown, true)
    }
  }, [handleCloseWithFocus])

  // ── Close on Escape ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCloseWithFocus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleCloseWithFocus])

  // ── Compute position with floating-ui ─────────────────────────────
  // Uses `autoUpdate` so the menu reflows on scroll/resize while open,
  // mirroring `BlockPropertyEditor.tsx` and `suggestion-renderer.ts`
  // (AGENTS.md §"Floating UI lifecycle logging").
  const [computedPos, setComputedPos] = useState(position)
  // Defer the entrance animation until floating-ui has resolved the
  // final coordinates. Without this, `animate-in fade-in-0 zoom-in-95`
  // begins on the initial anchor coords and visibly jumps once
  // `computePosition` settles a frame later.
  const [positioned, setPositioned] = useState(false)

  useEffect(() => {
    const el = menuRef.current
    if (!el) return

    const triggerEl = triggerRef?.current ?? null

    const virtualEl = {
      getBoundingClientRect: () => new DOMRect(position.x, position.y, 0, 0),
      // `contextElement` lets `autoUpdate` discover the right scroll
      // ancestors when the reference is a virtual element.
      ...(triggerEl ? { contextElement: triggerEl } : {}),
    }

    const updatePosition = () => {
      // Stale-unmount guard: the floating element or its trigger may
      // have been removed from the DOM between this `autoUpdate` tick
      // and the previous one. Bail loudly so latent bugs surface.
      if (!el.isConnected) {
        logger.warn('BlockContextMenu', 'floating element unmounted, skipping update')
        return
      }
      if (triggerEl && !triggerEl.isConnected) {
        logger.warn('BlockContextMenu', 'trigger unmounted, skipping update', {
          blockId,
        })
        return
      }

      computePosition(virtualEl, el, {
        placement: 'bottom-start',
        middleware: [
          offset(4),
          flip({ padding: 8 }),
          shift({ padding: 8 }),
          // #987: when the menu is taller than the viewport, flip/shift can't
          // resolve the overflow (both placements overrun) and the bottom of
          // the menu was clipped by the window. Cap the height to the space
          // floating-ui leaves and let the list scroll inside it.
          size({
            padding: 8,
            apply({ availableHeight, elements }) {
              elements.floating.style.maxHeight = `${Math.max(120, availableHeight)}px`
              elements.floating.style.overflowY = 'auto'
            },
          }),
        ],
      })
        .then(({ x, y }) => {
          if (!el.isConnected) return
          setComputedPos({ x, y })
          setPositioned(true)
        })
        .catch((err: unknown) => {
          logger.warn(
            'BlockContextMenu',
            'positioning failed, falling back to anchor coords',
            { x: position.x, y: position.y },
            err,
          )
          setComputedPos({ x: position.x, y: position.y })
          setPositioned(true)
        })
    }

    return autoUpdate(virtualEl, el, updatePosition)
  }, [position, triggerRef, blockId])

  // Fix 6 — "bulk" mode: the menu was opened on a block that is part of an
  // active multi-selection of >1 block. In that case Delete / TODO / Priority /
  // Move apply to EVERY selected block. Single-block behaviour (no selection,
  // or a selection that does not contain the right-clicked block) is unchanged.
  const bulkIds =
    selectedBlockIds && selectedBlockIds.length > 1 && selectedBlockIds.includes(blockId)
      ? selectedBlockIds
      : null
  const isBulk = bulkIds !== null

  const handleAction = useCallback(
    (action: ((blockId: string) => void | Promise<void>) | undefined) => {
      if (!action) return
      // Wrap in try/catch so sync throws and async rejections both surface
      // as a toast + log instead of silently closing the menu (the user's
      // intent — "do this thing" — was not honoured, so leave the menu
      // open and let them retry or dismiss manually).
      void (async () => {
        try {
          await Promise.resolve(action(blockId))
          onClose()
        } catch (err) {
          logger.error('BlockContextMenu', 'action failed', { blockId }, err)
          notify.error(t('contextMenu.actionFailed'))
        }
      })()
    },
    [blockId, onClose, t],
  )

  // Fix 6 — apply a per-block action across the whole selection. Each id is
  // awaited in turn so one failure surfaces a toast but doesn't abort the rest;
  // the menu closes once the batch is dispatched. Used for ops that have no
  // dedicated single-IPC batch endpoint (TODO cycle, priority cycle, move).
  const handleBulkAction = useCallback(
    (action: ((blockId: string) => void | Promise<void>) | undefined, ids: string[]) => {
      if (!action) return
      void (async () => {
        let anyFailed = false
        for (const id of ids) {
          try {
            await Promise.resolve(action(id))
          } catch (err) {
            anyFailed = true
            logger.error('BlockContextMenu', 'bulk action failed', { id }, err)
          }
        }
        if (anyFailed) notify.error(t('contextMenu.actionFailed'))
        onClose()
      })()
    },
    [onClose, t],
  )

  // Route an action through bulk mode when a multi-selection is active, else
  // run it against the single right-clicked block. `action` is the per-block
  // callback (e.g. `onTogglePriority`); the returned thunk is dropped into a
  // menu item's `action` slot.
  const dispatch = useCallback(
    (action: ((blockId: string) => void | Promise<void>) | undefined) =>
      isBulk ? handleBulkAction(action, bulkIds) : handleAction(action),
    [isBulk, bulkIds, handleBulkAction, handleAction],
  )

  // ── Menu item groups ─────────────────────────────────────────────

  // Group 1: Delete
  // Fix 6 — in bulk mode prefer the dedicated single-IPC batch delete
  // (`onBatchDelete`: confirm dialog + undo toast) over looping `onDelete`.
  // The label reflects the selection count so it's clear the whole selection
  // goes. Outside bulk mode this is the unchanged single-block delete.
  const deleteAction = isBulk
    ? onBatchDelete
      ? () => {
          onBatchDelete()
          onClose()
        }
      : onDelete
        ? () => handleBulkAction(onDelete, bulkIds)
        : undefined
    : onDelete
      ? () => handleAction(onDelete)
      : undefined
  const group1: MenuItem[] = [
    {
      label: isBulk
        ? t('contextMenu.deleteSelected', { count: bulkIds.length })
        : t('contextMenu.delete'),
      icon: <Trash2 className="h-3.5 w-3.5" />,
      action: deleteAction,
      className: 'text-destructive hover:bg-destructive/10',
      // #976 (item 16) — surface the delete binding. It's positional
      // (`deleteBlock`: Backspace on an empty block), so the hint carries the
      // "(when empty)" condition rather than implying Backspace always deletes.
      // Suppressed in bulk mode, where the batch-delete has no single-key chord.
      // #1728 — the key is sourced from the `deleteBlock` catalog entry
      // (positional, documentation-only); the "(when empty)" condition stays
      // appended verbatim.
      ...(isBulk ? {} : { shortcut: `${shortcutHint('deleteBlock')} (when empty)` }),
    },
  ]

  // Group 2: Indent / Dedent stay inline (high-frequency, single-press chorded);
  // the low-frequency ops (Move up/down, Duplicate, Merge) collapse behind a
  // "Move & arrange" disclosure (#1109).
  const indentDedentItems: MenuItem[] = [
    {
      label: t('contextMenu.indent'),
      icon: <ArrowRightToLine className="h-3.5 w-3.5" />,
      action: onIndent ? () => dispatch(onIndent) : undefined,
      shortcut: shortcutHint('indentBlock'),
    },
    {
      label: t('contextMenu.dedent'),
      icon: <ArrowLeftToLine className="h-3.5 w-3.5" />,
      action: onDedent ? () => dispatch(onDedent) : undefined,
      shortcut: shortcutHint('dedentBlock'),
    },
  ]

  // #1109 — the collapsible "Move & arrange" children: Move up/down, Duplicate,
  // Merge. Each child keeps its EXACT prior action + shortcut (no behaviour
  // change); only its disclosure/organisation moves behind the toggle. Children
  // carry `indented` + `disclosureId` so they render as a labelled, indented
  // subgroup (mirroring the "Turn into" options).
  const moveArrangeChildren: MenuItem[] = [
    {
      label: t('contextMenu.moveUp'),
      icon: <MoveUp className="h-3.5 w-3.5" />,
      action: onMoveUp ? () => dispatch(onMoveUp) : undefined,
      shortcut: shortcutHint('moveBlockUp'),
      indented: true,
      disclosureId: moveArrangeGroupId,
      disclosureLabel: t('contextMenu.moveArrange'),
    },
    {
      label: t('contextMenu.moveDown'),
      icon: <MoveDown className="h-3.5 w-3.5" />,
      action: onMoveDown ? () => dispatch(onMoveDown) : undefined,
      shortcut: shortcutHint('moveBlockDown'),
      indented: true,
      disclosureId: moveArrangeGroupId,
      disclosureLabel: t('contextMenu.moveArrange'),
    },
    // #976 (item 13) — Duplicate the block + its subtree (insert after the
    // original at the same depth). Single-block only: in bulk mode the action
    // is omitted (duplicating a heterogeneous selection has no single intuitive
    // anchor; the batch toolbar owns multi-block ops).
    ...(onDuplicate && !isBulk
      ? [
          {
            label: t('contextMenu.duplicate'),
            icon: <CopyPlus className="h-3.5 w-3.5" />,
            action: () => handleAction(onDuplicate),
            // #976 (item 13) — surface the `duplicateBlock` catalog binding,
            // matching the adjacent move/merge hints. #1728 — sourced from the
            // catalog (default `Ctrl+Shift+J`) so a rebind/platform glyph shows.
            shortcut: shortcutHint('duplicateBlock'),
            indented: true,
            disclosureId: moveArrangeGroupId,
            disclosureLabel: t('contextMenu.moveArrange'),
          },
        ]
      : []),
    ...(onMerge
      ? [
          {
            label: t('contextMenu.merge'),
            icon: <Merge className="h-3.5 w-3.5" />,
            action: () => handleAction(onMerge),
            // #976 (item 17) — surface the merge binding. It's positional
            // (`mergeWithPrevious`: Backspace at the start of the block), so the
            // hint carries the "(at start)" condition to avoid implying a bare
            // Backspace deletes the block. #1728 — key sourced from the
            // `mergeWithPrevious` catalog entry (positional, documentation-only).
            shortcut: `${shortcutHint('mergeWithPrevious')} (at start)`,
            indented: true,
            disclosureId: moveArrangeGroupId,
            disclosureLabel: t('contextMenu.moveArrange'),
          },
        ]
      : []),
  ]

  // Only show the "Move & arrange" toggle when at least one child action is
  // actually wired (else the disclosure would expand to nothing). The toggle is
  // a plain expand/collapse — it dispatches no block action itself.
  const hasMoveArrangeChildren = moveArrangeChildren.some((item) => item.action !== undefined)
  const group2: MenuItem[] = [
    ...indentDedentItems,
    ...(hasMoveArrangeChildren
      ? [
          {
            label: t('contextMenu.moveArrange'),
            icon: <MoveVertical className="h-3.5 w-3.5" />,
            action: () => setMoveArrangeOpen((o) => !o),
            expanded: moveArrangeOpen,
            disclosureId: moveArrangeGroupId,
          },
          ...(moveArrangeOpen ? moveArrangeChildren : []),
        ]
      : []),
  ]

  // Group 3: Collapse/Expand (only if hasChildren)
  const group3: MenuItem[] = hasChildren
    ? [
        {
          label: isCollapsed ? t('contextMenu.expand') : t('contextMenu.collapse'),
          icon: isCollapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          ),
          action: onToggleCollapse ? () => handleAction(onToggleCollapse) : undefined,
          shortcut: shortcutHint('collapseExpand'),
        },
        ...(onZoomIn
          ? [
              {
                label: t('contextMenu.zoomIn'),
                icon: <ZoomIn className="h-3.5 w-3.5" />,
                action: () => handleAction(onZoomIn),
                // #976 (item 18) — surface the `zoomIn` catalog binding (Alt+.),
                // matching the adjacent collapse / properties hints. #1728 —
                // sourced from the catalog so a rebind/platform glyph shows.
                shortcut: shortcutHint('zoomIn'),
              },
            ]
          : []),
      ]
    : []

  // Group 4: TODO cycle, Priority cycle
  const group4: MenuItem[] = [
    {
      // In bulk mode the per-block cycle label ("TODO → DOING" etc.) would be
      // misleading across a heterogeneous selection, so show a neutral
      // "Cycle task state" label; the action cycles every selected block.
      label: isBulk ? t('contextMenu.cycleTodoSelected') : getTodoLabel(todoState, t),
      icon: <CheckSquare className="h-3.5 w-3.5" />,
      action: onToggleTodo ? () => dispatch(onToggleTodo) : undefined,
      shortcut: shortcutHint('cycleTaskState'),
    },
    {
      label: isBulk ? t('contextMenu.cyclePrioritySelected') : getPriorityLabel(priority, t),
      icon: <Signal className="h-3.5 w-3.5" />,
      action: onTogglePriority ? () => dispatch(onTogglePriority) : undefined,
      // #976 (item 19) — `'Ctrl+Shift+1-3'` read ambiguously as "press 1 then 2
      // then 3"; the catalog defines three INDEPENDENT bindings
      // (`priority1`/`priority2`/`priority3`). Alternation notation ("1/2/3")
      // makes it clear any one of the three sets that priority. #1728 — the
      // chord is now sourced from those catalog ids (rebind/platform aware).
      shortcut: priorityHint(),
    },
  ]

  // Group 5: History
  const group5: MenuItem[] = [
    ...(onShowHistory
      ? [
          {
            label: t('contextMenu.history'),
            icon: <Clock className="h-3.5 w-3.5" />,
            action: () => handleAction(onShowHistory),
            // #976 (item 15) — surface the block-history binding, matching the
            // adjacent properties row. #1728 — sourced from the catalog
            // (`openBlockHistory`) so a rebind/platform glyph is reflected.
            shortcut: shortcutHint('openBlockHistory'),
          },
        ]
      : []),
    ...(onShowProperties
      ? [
          {
            label: t('contextMenu.properties'),
            icon: <Settings2 className="h-3.5 w-3.5" />,
            action: () => handleAction(onShowProperties),
            // #1728 — sourced from the `openPropertiesDrawer` catalog entry.
            shortcut: shortcutHint('openPropertiesDrawer'),
          },
        ]
      : []),
  ]

  // Link group (shown only when right-clicking/long-pressing an external link):
  // "Open link" (→ system browser) and "Copy URL". #924 — discoverable,
  // non-modifier counterpart to the editor's Ctrl/Cmd+Click open path.
  const openLinkItem: MenuItem | null = linkUrl
    ? {
        label: t('contextMenu.openLink'),
        icon: <ExternalLink className="h-3.5 w-3.5" />,
        action: () => {
          void (async () => {
            // openUrl never rejects — it returns false when neither the
            // Tauri shell nor window.open could open a tab. Surface that
            // as a toast rather than silently closing on a no-op.
            const opened = await openUrl(linkUrl)
            if (!opened) {
              logger.warn('BlockContextMenu', 'Failed to open external link', { url: linkUrl })
              notify.error(t('contextMenu.actionFailed'))
            }
            onClose()
          })()
        },
      }
    : null

  const copyUrlItem: MenuItem | null = linkUrl
    ? {
        label: t('contextMenu.copyUrl'),
        icon: <Copy className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            await writeText(linkUrl)
            notify.success(t('contextMenu.urlCopied'))
          } catch (err) {
            logger.error(
              'BlockContextMenu',
              'Failed to copy URL to clipboard',
              { url: linkUrl },
              err,
            )
            notify.error(t('contextMenu.copyUrlFailed'))
          }
          onClose()
        },
      }
    : null

  // #1445 — "Copy block reference" copies a Roam-style block ref (`((ULID))`)
  // for the right-clicked block, mirroring the palette's "Copy block link"
  // shape. Always available (every block has an id); follows the `copyUrlItem`
  // pattern (writeText + success/error toast + close).
  const copyBlockRefItem: MenuItem = {
    label: t('contextMenu.copyBlockRef'),
    icon: <Copy className="h-3.5 w-3.5" />,
    action: async () => {
      try {
        await writeText(`((${blockId}))`)
        notify.success(t('contextMenu.blockRefCopied'))
      } catch (err) {
        logger.error('BlockContextMenu', 'Failed to copy block reference', { blockId }, err)
        notify.error(t('contextMenu.copyRefFailed'))
      }
      onClose()
    },
  }

  // #1445 — "Copy page reference" copies a page link (`[[ULID]]`) for the
  // containing page (or the block's own id when the block IS a page). Hidden
  // when `pageRefId` is unknown. Emits `[[ULID]]`, matching the palette's
  // "Copy page link" page action (#1521 aligned the palette, which previously
  // copied a bare, unpasteable ULID).
  const copyPageRefItem: MenuItem | null = pageRefId
    ? {
        label: t('contextMenu.copyPageRef'),
        icon: <Link2 className="h-3.5 w-3.5" />,
        action: async () => {
          try {
            await writeText(`[[${pageRefId}]]`)
            notify.success(t('contextMenu.pageRefCopied'))
          } catch (err) {
            logger.error('BlockContextMenu', 'Failed to copy page reference', { pageRefId }, err)
            notify.error(t('contextMenu.copyRefFailed'))
          }
          onClose()
        },
      }
    : null

  const linkGroup = [openLinkItem, copyUrlItem, copyBlockRefItem, copyPageRefItem].filter(
    (item): item is MenuItem => item !== null,
  )

  // #264 — "Turn into" group. A parent toggle row ("Turn into" + chevron) that
  // expands to the block-type options inline. Each option converts the block
  // via `onTurnInto` and closes the menu; the block's current type is marked
  // active and rendered as a non-interactive indicator (converting to the
  // current type is a no-op the user shouldn't reach for).
  const turnIntoGroup: MenuItem[] = onTurnInto
    ? [
        {
          label: t('contextMenu.turnInto'),
          icon: <Replace className="h-3.5 w-3.5" />,
          action: () => setTurnIntoOpen((o) => !o),
          expanded: turnIntoOpen,
          disclosureId: turnIntoGroupId,
          // #976 (item 14) — surface the `turnIntoBlock` catalog binding next to
          // the disclosure chevron. #1728 — sourced from the catalog (default
          // `Ctrl+Shift+T`) so a rebind/platform glyph is reflected.
          shortcut: shortcutHint('turnIntoBlock'),
        },
        ...(turnIntoOpen
          ? TURN_INTO_OPTIONS.map((opt): MenuItem => {
              const Icon = opt.icon
              const blockType = opt.blockType as BlockTypeToken
              const isActive = activeBlockType === blockType
              return {
                label: t(turnIntoTypeKey(opt.blockType)),
                // #999 — keep the type icon at the file-wide size; indentation
                // is applied once at the row level via `indented` (below), not
                // via an ad-hoc per-icon `ml-3`.
                icon: Icon ? <Icon className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5" />,
                active: isActive,
                indented: true,
                disclosureId: turnIntoGroupId,
                disclosureLabel: t('contextMenu.turnInto'),
                action: isActive
                  ? undefined
                  : () => {
                      onTurnInto(blockId, blockType)
                      onClose()
                    },
              }
            })
          : []),
      ]
    : []

  // Filter out items without actions and empty groups.
  //
  // #217 A1 — order for calm scannability and mis-click safety: contextual
  // link actions (Open link / Copy URL) · Tasks (TODO/Priority) · Block ops
  // (indent/move/merge) · View (collapse/zoom) · History/Properties · Delete
  // LAST. The destructive Delete previously sat at the very top (group1) — the
  // easiest item to mis-click; it now lives at the bottom, visually separated
  // by the existing inter-group divider and its `text-destructive` styling.
  const groups = [linkGroup, group4, turnIntoGroup, group2, group3, group5, group1]
    // Keep actionable items, plus the active "Turn into" indicator row (which
    // has no action by design — it shows the block's current type).
    .map((group) => group.filter((item) => item.action !== undefined || item.active))
    .filter((group) => group.length > 0)

  // Only actionable items participate in keyboard roving focus; the active
  // indicator row is skipped.
  const visibleItems = groups.flat().filter((item) => item.action !== undefined)

  // ── Keyboard navigation ──────────────────────────────────────────
  const { focusedIndex, handleKeyDown: navHandleKeyDown } = useListKeyboardNavigation({
    itemCount: visibleItems.length,
    wrap: true,
    homeEnd: true,
  })

  // ── Focus first item on mount and whenever the visible item set changes ──
  // Items are conditional (zoom-in only when `hasChildren`, history only when
  // `onShowHistory` is passed, etc.) — refire whenever the count changes so
  // focus lands on the current first item rather than a stale reference.
  useEffect(() => {
    itemRefs.current[0]?.focus()
  }, [visibleItems.length])

  // ── Focus item on focusedIndex change ────────────────────────────
  useEffect(() => {
    itemRefs.current[focusedIndex]?.focus()
  }, [focusedIndex])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (navHandleKeyDown(e)) {
        e.preventDefault()
      }
    },
    [navHandleKeyDown],
  )

  // #999/#1003/#1109 — the per-render roving-focus counter; the extracted
  // `renderMenuItem` advances it for each interactive (actionable) row, exactly
  // as the inline render loop did. Reset before each render pass.
  let itemIndex = 0
  const renderItem = (item: MenuItem): React.ReactElement =>
    renderMenuItem(item, {
      focusedIndex,
      itemRefs,
      nextIndex: () => itemIndex++,
    })

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={t('contextMenu.blockActions')}
      className={cn(
        'block-context-menu fixed z-50 min-w-[160px] rounded-lg border bg-popover p-1 shadow-(--shadow-floating)',
        positioned ? 'animate-in fade-in-0 zoom-in-95 opacity-100' : 'opacity-0',
      )}
      style={{ left: computedPos.x, top: computedPos.y }}
      onKeyDown={handleKeyDown}
      data-editor-portal=""
    >
      {groups.map((group, groupIdx) => {
        // #1003/#1109 — a disclosure's child options (marked `indented`) are
        // wrapped in their own labelled `role="group"` (linked to the toggle via
        // `disclosureId`) so the nesting is exposed to screen readers. They're
        // always contiguous at the tail of their group; the non-indented rows
        // render flat above them. Each indented subgroup carries its own id +
        // label ("Turn into", "Move & arrange") read from its first child.
        const flatItems = group.filter((item) => !item.indented)
        const indentedItems = group.filter((item) => item.indented)
        const subgroupId = indentedItems[0]?.disclosureId
        const subgroupLabel = indentedItems[0]?.disclosureLabel
        return (
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- menu-item group inside a custom menu; <fieldset>/<optgroup> etc. would inject form/list semantics that conflict with the menu role
          <div key={group[0]?.label ?? `group-${groupIdx}`} role="group">
            {groupIdx > 0 && <hr className="my-1 h-px border-0 bg-border" />}
            {flatItems.map(renderItem)}
            {indentedItems.length > 0 && (
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- nested menu-item subgroup; see above
              <div id={subgroupId} role="group" aria-label={subgroupLabel}>
                {indentedItems.map(renderItem)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )

  // Don't render anything when there are no actionable items: showing an
  // empty menu (or a "No actions available" placeholder) is a dead end —
  // the user can't do anything but dismiss it. Short-circuit so the menu
  // simply never appears.
  return createPortal(visibleItems.length === 0 ? null : menu, document.body)
}
