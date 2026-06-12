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

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Merge,
  MoveDown,
  MoveUp,
  Replace,
  Settings2,
  Signal,
  Trash2,
  ZoomIn,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useListKeyboardNavigation } from '@/hooks/useListKeyboardNavigation'
import type { BlockTypeToken } from '@/lib/block-type-convert'
import { writeText } from '@/lib/clipboard'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { openUrl } from '@/lib/open-url'
import { TURN_INTO_OPTIONS } from '@/lib/slash-commands'
import { cn } from '@/lib/utils'

export interface BlockContextMenuProps {
  blockId: string
  position: { x: number; y: number }
  onClose: () => void
  /** Ref to the element that triggered the menu, for focus restoration. */
  triggerRef?: React.RefObject<HTMLElement | null> | undefined
  onDelete?: ((blockId: string) => void) | undefined
  onIndent?: ((blockId: string) => void) | undefined
  onDedent?: ((blockId: string) => void) | undefined
  onToggleTodo?: ((blockId: string) => void) | undefined
  onTogglePriority?: ((blockId: string) => void) | undefined
  onToggleCollapse?: ((blockId: string) => void) | undefined
  onMoveUp?: ((blockId: string) => void) | undefined
  onMoveDown?: ((blockId: string) => void) | undefined
  onMerge?: ((blockId: string) => void) | undefined
  hasChildren?: boolean | undefined
  isCollapsed?: boolean | undefined
  todoState?: (string | null) | undefined
  priority?: (string | null) | undefined
  /** Due date in YYYY-MM-DD format (for future use). */
  dueDate?: (string | null) | undefined
  /** Show block history */
  onShowHistory?: ((blockId: string) => void) | undefined
  /** Show block properties drawer */
  onShowProperties?: ((blockId: string) => void) | undefined
  /** Zoom in to show only this block's children */
  onZoomIn?: ((blockId: string) => void) | undefined
  /** URL of external link under cursor (for Copy URL action). */
  linkUrl?: string | undefined
  /**
   * #264 — convert this block to another block type ("Turn into ▸"). When
   * provided, the menu renders a "Turn into" group listing the block-type
   * options. `activeBlockType` highlights the block's current type.
   */
  onTurnInto?: ((blockId: string, blockType: BlockTypeToken) => void) | undefined
  /** Current block type, used to indicate the active option in "Turn into". */
  activeBlockType?: BlockTypeToken | undefined
}

interface MenuItem {
  label: string
  icon: React.ReactNode
  action: (() => void) | undefined
  className?: string
  shortcut?: string
  /** #264 — marks the active block type inside the "Turn into" group. */
  active?: boolean
}

// ── State-aware label helpers ─────────────────────────────────────────

function getTodoLabel(todoState: string | null | undefined, t: (key: string) => string): string {
  switch (todoState) {
    case 'TODO':
      return t('contextMenu.todoToDoing')
    case 'DOING':
      return t('contextMenu.doingToDone')
    case 'DONE':
      return t('contextMenu.doneToCancelled')
    case 'CANCELLED':
      return t('contextMenu.cancelledToClear')
    default:
      return t('contextMenu.setTodo')
  }
}

function getPriorityLabel(priority: string | null | undefined, t: (key: string) => string): string {
  switch (priority) {
    case '1':
      return t('contextMenu.priority1To2')
    case '2':
      return t('contextMenu.priority2To3')
    case '3':
      return t('contextMenu.priority3ToClear')
    default:
      return t('contextMenu.setPriority1')
  }
}

export function BlockContextMenu({
  blockId,
  position,
  onClose,
  triggerRef,
  onDelete,
  onIndent,
  onDedent,
  onToggleTodo,
  onTogglePriority,
  onToggleCollapse,
  onMoveUp,
  onMoveDown,
  onMerge,
  hasChildren,
  isCollapsed,
  todoState,
  priority,
  dueDate: _dueDate,
  onShowHistory,
  onShowProperties,
  onZoomIn,
  linkUrl,
  onTurnInto,
  activeBlockType,
}: BlockContextMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // #264 — the "Turn into" group is collapsed by default; expanding reveals
  // the block-type options inline (no nested floating popover, so the existing
  // single-list keyboard navigation keeps working).
  const [turnIntoOpen, setTurnIntoOpen] = useState(false)

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
        middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
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

  // ── Menu item groups ─────────────────────────────────────────────

  // Group 1: Delete
  const group1: MenuItem[] = [
    {
      label: t('contextMenu.delete'),
      icon: <Trash2 className="h-3.5 w-3.5" />,
      action: onDelete ? () => handleAction(onDelete) : undefined,
      className: 'text-destructive hover:bg-destructive/10',
    },
  ]

  // Group 2: Indent, Dedent, Move Up, Move Down
  const group2: MenuItem[] = [
    {
      label: t('contextMenu.indent'),
      icon: <ArrowRightToLine className="h-3.5 w-3.5" />,
      action: onIndent ? () => handleAction(onIndent) : undefined,
      shortcut: 'Ctrl+Shift+→',
    },
    {
      label: t('contextMenu.dedent'),
      icon: <ArrowLeftToLine className="h-3.5 w-3.5" />,
      action: onDedent ? () => handleAction(onDedent) : undefined,
      shortcut: 'Ctrl+Shift+←',
    },
    {
      label: t('contextMenu.moveUp'),
      icon: <MoveUp className="h-3.5 w-3.5" />,
      action: onMoveUp ? () => handleAction(onMoveUp) : undefined,
      shortcut: 'Ctrl+Shift+↑',
    },
    {
      label: t('contextMenu.moveDown'),
      icon: <MoveDown className="h-3.5 w-3.5" />,
      action: onMoveDown ? () => handleAction(onMoveDown) : undefined,
      shortcut: 'Ctrl+Shift+↓',
    },
    ...(onMerge
      ? [
          {
            label: t('contextMenu.merge'),
            icon: <Merge className="h-3.5 w-3.5" />,
            action: () => handleAction(onMerge),
          },
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
          shortcut: 'Ctrl+.',
        },
        ...(onZoomIn
          ? [
              {
                label: t('contextMenu.zoomIn'),
                icon: <ZoomIn className="h-3.5 w-3.5" />,
                action: () => handleAction(onZoomIn),
              },
            ]
          : []),
      ]
    : []

  // Group 4: TODO cycle, Priority cycle
  const group4: MenuItem[] = [
    {
      label: getTodoLabel(todoState, t),
      icon: <CheckSquare className="h-3.5 w-3.5" />,
      action: onToggleTodo ? () => handleAction(onToggleTodo) : undefined,
      shortcut: 'Ctrl+Enter',
    },
    {
      label: getPriorityLabel(priority, t),
      icon: <Signal className="h-3.5 w-3.5" />,
      action: onTogglePriority ? () => handleAction(onTogglePriority) : undefined,
      shortcut: 'Ctrl+Shift+1-3',
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
          },
        ]
      : []),
    ...(onShowProperties
      ? [
          {
            label: t('contextMenu.properties'),
            icon: <Settings2 className="h-3.5 w-3.5" />,
            action: () => handleAction(onShowProperties),
            shortcut: 'Ctrl+Shift+P',
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

  const linkGroup = [openLinkItem, copyUrlItem].filter((item): item is MenuItem => item !== null)

  // #264 — "Turn into" group. A parent toggle row ("Turn into ▸/▾") that
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
          shortcut: turnIntoOpen ? '▾' : '▸',
        },
        ...(turnIntoOpen
          ? TURN_INTO_OPTIONS.map((opt): MenuItem => {
              const Icon = opt.icon
              const blockType = opt.blockType as BlockTypeToken
              const isActive = activeBlockType === blockType
              return {
                label: t(`contextMenu.turnIntoType.${opt.blockType}`),
                icon: Icon ? <Icon className="ml-3 h-3.5 w-3.5" /> : <span className="ml-3" />,
                active: isActive,
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
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- visibleItems.length IS the trigger — we refocus when the conditional item set toggles, even though the effect body doesn't read it
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

  let itemIndex = 0

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      tabIndex={-1}
      aria-label={t('contextMenu.blockActions')}
      className={cn(
        'block-context-menu fixed z-50 min-w-[160px] rounded-lg border bg-popover p-1 shadow-md',
        positioned ? 'animate-in fade-in-0 zoom-in-95 opacity-100' : 'opacity-0',
      )}
      style={{ left: computedPos.x, top: computedPos.y }}
      onKeyDown={handleKeyDown}
      data-editor-portal=""
    >
      {groups.map((group, groupIdx) => (
        // oxlint-disable-next-line react/no-array-index-key -- groups are static per render, never reorder
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- menu-item group inside a custom menu; <fieldset>/<optgroup> etc. would inject form/list semantics that conflict with the menu role
        <div key={groupIdx} role="group">
          {groupIdx > 0 && <hr className="my-1 h-px border-0 bg-border" />}
          {group.map((item) => {
            // #264 — the active "Turn into" type renders as a non-interactive
            // indicator: no action, no `itemIndex`, skipped by roving focus.
            if (item.action === undefined && item.active) {
              return (
                <div
                  key={item.label}
                  role="menuitem"
                  aria-disabled="true"
                  aria-current="true"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-accent-foreground bg-accent/60"
                >
                  {item.icon}
                  <span className="flex-1">{item.label}</span>
                  <span className="ml-4 text-xs text-muted-foreground">✓</span>
                </div>
              )
            }
            const idx = itemIndex++
            return (
              <button
                key={item.label}
                ref={(el) => {
                  itemRefs.current[idx] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={idx === focusedIndex ? 0 : -1}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none transition-colors touch-target',
                  item.className,
                )}
                onClick={item.action}
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {item.shortcut && (
                  <span className="ml-4 text-xs text-muted-foreground">{item.shortcut}</span>
                )}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )

  // Don't render anything when there are no actionable items: showing an
  // empty menu (or a "No actions available" placeholder) is a dead end —
  // the user can't do anything but dismiss it. Short-circuit so the menu
  // simply never appears.
  return createPortal(visibleItems.length === 0 ? null : menu, document.body)
}
