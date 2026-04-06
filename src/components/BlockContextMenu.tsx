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

import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  Merge,
  MoveDown,
  MoveUp,
  Settings2,
  Signal,
  Trash2,
  ZoomIn,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useListKeyboardNavigation } from '../hooks/useListKeyboardNavigation'
import { cn } from '../lib/utils'

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
}

interface MenuItem {
  label: string
  icon: React.ReactNode
  action: (() => void) | undefined
  className?: string
  shortcut?: string
}

// ── State-aware label helpers ─────────────────────────────────────────

function getTodoLabel(todoState: string | null | undefined, t: (key: string) => string): string {
  switch (todoState) {
    case 'TODO':
      return t('contextMenu.todoToDoing')
    case 'DOING':
      return t('contextMenu.doingToDone')
    case 'DONE':
      return t('contextMenu.doneToClear')
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
}: BlockContextMenuProps): React.ReactElement {
  const { t } = useTranslation()
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const handleCloseWithFocus = useCallback(() => {
    triggerRef?.current?.focus()
    onClose()
  }, [triggerRef, onClose])

  // ── Close on click outside ───────────────────────────────────────
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        handleCloseWithFocus()
      }
    }
    // Use pointerdown to catch both mouse and touch
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
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

  // ── Focus first item on mount ────────────────────────────────────
  useEffect(() => {
    itemRefs.current[0]?.focus()
  }, [])

  // ── Compute position with floating-ui ─────────────────────────────
  const [computedPos, setComputedPos] = useState(position)

  useEffect(() => {
    const el = menuRef.current
    if (!el) return

    const virtualEl = {
      getBoundingClientRect: () => new DOMRect(position.x, position.y, 0, 0),
    }

    computePosition(virtualEl, el, {
      placement: 'bottom-start',
      middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      setComputedPos({ x, y })
    })
  }, [position])

  const handleAction = useCallback(
    (action: ((blockId: string) => void) | undefined) => {
      action?.(blockId)
      onClose()
    },
    [blockId, onClose],
  )

  // ── Menu item groups ─────────────────────────────────────────────

  // Group 1: Delete
  const group1: MenuItem[] = [
    {
      label: t('contextMenu.delete'),
      icon: <Trash2 size={14} />,
      action: onDelete ? () => handleAction(onDelete) : undefined,
      className: 'text-destructive hover:bg-destructive/10',
    },
  ]

  // Group 2: Indent, Dedent, Move Up, Move Down
  const group2: MenuItem[] = [
    {
      label: t('contextMenu.indent'),
      icon: <ArrowRightToLine size={14} />,
      action: onIndent ? () => handleAction(onIndent) : undefined,
      shortcut: 'Ctrl+Shift+→',
    },
    {
      label: t('contextMenu.dedent'),
      icon: <ArrowLeftToLine size={14} />,
      action: onDedent ? () => handleAction(onDedent) : undefined,
      shortcut: 'Ctrl+Shift+←',
    },
    {
      label: t('contextMenu.moveUp'),
      icon: <MoveUp size={14} />,
      action: onMoveUp ? () => handleAction(onMoveUp) : undefined,
      shortcut: 'Ctrl+Shift+↑',
    },
    {
      label: t('contextMenu.moveDown'),
      icon: <MoveDown size={14} />,
      action: onMoveDown ? () => handleAction(onMoveDown) : undefined,
      shortcut: 'Ctrl+Shift+↓',
    },
    ...(onMerge
      ? [
          {
            label: t('contextMenu.merge'),
            icon: <Merge size={14} />,
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
          icon: isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />,
          action: onToggleCollapse ? () => handleAction(onToggleCollapse) : undefined,
          shortcut: 'Ctrl+.',
        },
        ...(onZoomIn
          ? [
              {
                label: t('contextMenu.zoomIn'),
                icon: <ZoomIn size={14} />,
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
      icon: <CheckSquare size={14} />,
      action: onToggleTodo ? () => handleAction(onToggleTodo) : undefined,
      shortcut: 'Ctrl+Enter',
    },
    {
      label: getPriorityLabel(priority, t),
      icon: <Signal size={14} />,
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
            icon: <Clock size={14} />,
            action: () => handleAction(onShowHistory),
          },
        ]
      : []),
    ...(onShowProperties
      ? [
          {
            label: t('contextMenu.properties'),
            icon: <Settings2 size={14} />,
            action: () => handleAction(onShowProperties),
            shortcut: 'Ctrl+Shift+P',
          },
        ]
      : []),
  ]

  // Filter out items without actions and empty groups
  const groups = [group1, group2, group3, group4, group5]
    .map((group) => group.filter((item) => item.action !== undefined))
    .filter((group) => group.length > 0)

  const visibleItems = groups.flat()

  // ── Keyboard navigation ──────────────────────────────────────────
  const { focusedIndex, handleKeyDown: navHandleKeyDown } = useListKeyboardNavigation({
    itemCount: visibleItems.length,
    wrap: true,
    homeEnd: true,
  })

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
      aria-label={t('contextMenu.blockActions')}
      className="fixed z-50 min-w-[160px] rounded-lg border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: computedPos.x, top: computedPos.y }}
      onKeyDown={handleKeyDown}
    >
      {groups.map((group, groupIdx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: groups are static per render, never reorder
        // biome-ignore lint/a11y/useSemanticElements: fieldset is for forms, not menu item groups
        <div key={groupIdx} role="group">
          {groupIdx > 0 && <hr className="my-1 h-px border-0 bg-border" />}
          {group.map((item) => {
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
      {visibleItems.length === 0 && (
        <div className="px-2 py-1.5 text-sm text-muted-foreground">
          {t('contextMenu.noActions')}
        </div>
      )}
    </div>
  )

  return createPortal(menu, document.body)
}
