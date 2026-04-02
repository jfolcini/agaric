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

import {
  ArrowLeftToLine,
  ArrowRightToLine,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  MoveDown,
  MoveUp,
  Signal,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

export interface BlockContextMenuProps {
  blockId: string
  position: { x: number; y: number }
  onClose: () => void
  /** Ref to the element that triggered the menu, for focus restoration. */
  triggerRef?: React.RefObject<HTMLElement | null>
  onDelete?: (blockId: string) => void
  onIndent?: (blockId: string) => void
  onDedent?: (blockId: string) => void
  onToggleTodo?: (blockId: string) => void
  onTogglePriority?: (blockId: string) => void
  onToggleCollapse?: (blockId: string) => void
  onMoveUp?: (blockId: string) => void
  onMoveDown?: (blockId: string) => void
  hasChildren?: boolean
  isCollapsed?: boolean
  todoState?: string | null
  priority?: string | null
  /** Due date in YYYY-MM-DD format (for future use). */
  dueDate?: string | null
}

interface MenuItem {
  label: string
  icon: React.ReactNode
  action: (() => void) | undefined
  className?: string
  shortcut?: string
}

// ── State-aware label helpers ─────────────────────────────────────────

function getTodoLabel(todoState: string | null | undefined): string {
  switch (todoState) {
    case 'TODO':
      return 'TODO → DOING'
    case 'DOING':
      return 'DOING → DONE'
    case 'DONE':
      return 'DONE → Clear'
    default:
      return 'Set as TODO'
  }
}

function getPriorityLabel(priority: string | null | undefined): string {
  switch (priority) {
    case 'A':
      return 'Priority 1 → 2'
    case 'B':
      return 'Priority 2 → 3'
    case 'C':
      return 'Priority 3 → Clear'
    default:
      return 'Set priority 1'
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
  hasChildren,
  isCollapsed,
  todoState,
  priority,
  dueDate: _dueDate,
}: BlockContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
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

  // ── Focus item on focusedIndex change ────────────────────────────
  useEffect(() => {
    itemRefs.current[focusedIndex]?.focus()
  }, [focusedIndex])

  // ── Clamp position so the menu stays within the viewport ─────────
  const clampedPosition = useClampedPosition(position, menuRef)

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
      label: 'Delete',
      icon: <Trash2 size={14} />,
      action: onDelete ? () => handleAction(onDelete) : undefined,
      className: 'text-destructive hover:bg-destructive/10',
    },
  ]

  // Group 2: Indent, Dedent, Move Up, Move Down
  const group2: MenuItem[] = [
    {
      label: 'Indent',
      icon: <ArrowRightToLine size={14} />,
      action: onIndent ? () => handleAction(onIndent) : undefined,
      shortcut: 'Tab',
    },
    {
      label: 'Dedent',
      icon: <ArrowLeftToLine size={14} />,
      action: onDedent ? () => handleAction(onDedent) : undefined,
      shortcut: 'Shift+Tab',
    },
    {
      label: 'Move Up',
      icon: <MoveUp size={14} />,
      action: onMoveUp ? () => handleAction(onMoveUp) : undefined,
      shortcut: 'Ctrl+Shift+↑',
    },
    {
      label: 'Move Down',
      icon: <MoveDown size={14} />,
      action: onMoveDown ? () => handleAction(onMoveDown) : undefined,
      shortcut: 'Ctrl+Shift+↓',
    },
  ]

  // Group 3: Collapse/Expand (only if hasChildren)
  const group3: MenuItem[] = hasChildren
    ? [
        {
          label: isCollapsed ? 'Expand' : 'Collapse',
          icon: isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />,
          action: onToggleCollapse ? () => handleAction(onToggleCollapse) : undefined,
          shortcut: 'Ctrl+.',
        },
      ]
    : []

  // Group 4: TODO cycle, Priority cycle
  const group4: MenuItem[] = [
    {
      label: getTodoLabel(todoState),
      icon: <CheckSquare size={14} />,
      action: onToggleTodo ? () => handleAction(onToggleTodo) : undefined,
      shortcut: 'Ctrl+Enter',
    },
    {
      label: getPriorityLabel(priority),
      icon: <Signal size={14} />,
      action: onTogglePriority ? () => handleAction(onTogglePriority) : undefined,
      shortcut: 'Ctrl+Shift+1-3',
    },
  ]

  // Filter out items without actions and empty groups
  const groups = [group1, group2, group3, group4]
    .map((group) => group.filter((item) => item.action !== undefined))
    .filter((group) => group.length > 0)

  const visibleItems = groups.flat()

  // ── Keyboard navigation ──────────────────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIndex((prev) => (prev + 1) % visibleItems.length)
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIndex((prev) => (prev - 1 + visibleItems.length) % visibleItems.length)
          break
        case 'Home':
          e.preventDefault()
          setFocusedIndex(0)
          break
        case 'End':
          e.preventDefault()
          setFocusedIndex(visibleItems.length - 1)
          break
      }
    },
    [visibleItems.length],
  )

  let itemIndex = 0

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Block actions"
      className="fixed z-50 min-w-[160px] rounded-lg border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: clampedPosition.x, top: clampedPosition.y }}
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
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none transition-colors [@media(pointer:coarse)]:min-h-[44px]',
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
        <div className="px-2 py-1.5 text-sm text-muted-foreground">No actions available</div>
      )}
    </div>
  )

  return createPortal(menu, document.body)
}

// ── Viewport clamping helper ──────────────────────────────────────────

/**
 * Returns a position clamped so the menu doesn't overflow the viewport.
 * On first render, uses the raw position; once the menu mounts and we know
 * its size, we re-clamp. The visual shift is imperceptible (single frame).
 */
function useClampedPosition(
  position: { x: number; y: number },
  menuRef: React.RefObject<HTMLDivElement | null>,
): { x: number; y: number } {
  const PAD = 8 // px of breathing room from viewport edges

  // After first paint, check if the menu overflows and adjust
  const rect = menuRef.current?.getBoundingClientRect()
  if (!rect) return position

  let x = position.x
  let y = position.y

  if (x + rect.width > window.innerWidth - PAD) {
    x = window.innerWidth - rect.width - PAD
  }
  if (y + rect.height > window.innerHeight - PAD) {
    y = window.innerHeight - rect.height - PAD
  }
  if (x < PAD) x = PAD
  if (y < PAD) y = PAD

  return { x, y }
}
