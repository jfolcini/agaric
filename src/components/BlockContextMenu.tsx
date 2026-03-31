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

import { ArrowLeftToLine, ArrowRightToLine, CheckSquare, Signal, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../lib/utils'

export interface BlockContextMenuProps {
  blockId: string
  position: { x: number; y: number }
  onClose: () => void
  onDelete?: (blockId: string) => void
  onIndent?: (blockId: string) => void
  onDedent?: (blockId: string) => void
  onToggleTodo?: (blockId: string) => void
  onTogglePriority?: (blockId: string) => void
}

interface MenuItem {
  label: string
  icon: React.ReactNode
  action: (() => void) | undefined
  className?: string
}

export function BlockContextMenu({
  blockId,
  position,
  onClose,
  onDelete,
  onIndent,
  onDedent,
  onToggleTodo,
  onTogglePriority,
}: BlockContextMenuProps): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)

  // ── Close on click outside ───────────────────────────────────────
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    // Use pointerdown to catch both mouse and touch
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onClose])

  // ── Close on Escape ──────────────────────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // ── Clamp position so the menu stays within the viewport ─────────
  const clampedPosition = useClampedPosition(position, menuRef)

  const handleAction = useCallback(
    (action: ((blockId: string) => void) | undefined) => {
      action?.(blockId)
      onClose()
    },
    [blockId, onClose],
  )

  const items: MenuItem[] = [
    {
      label: 'Delete',
      icon: <Trash2 size={14} />,
      action: onDelete ? () => handleAction(onDelete) : undefined,
      className: 'text-destructive hover:bg-destructive/10',
    },
    {
      label: 'Indent',
      icon: <ArrowRightToLine size={14} />,
      action: onIndent ? () => handleAction(onIndent) : undefined,
    },
    {
      label: 'Dedent',
      icon: <ArrowLeftToLine size={14} />,
      action: onDedent ? () => handleAction(onDedent) : undefined,
    },
    {
      label: 'Set TODO',
      icon: <CheckSquare size={14} />,
      action: onToggleTodo ? () => handleAction(onToggleTodo) : undefined,
    },
    {
      label: 'Set Priority',
      icon: <Signal size={14} />,
      action: onTogglePriority ? () => handleAction(onTogglePriority) : undefined,
    },
  ]

  // Only show items whose callbacks are wired up
  const visibleItems = items.filter((item) => item.action !== undefined)

  const menu = (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Block actions"
      className="fixed z-50 min-w-[160px] rounded-lg border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: clampedPosition.x, top: clampedPosition.y }}
    >
      {visibleItems.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-popover-foreground hover:bg-accent hover:text-accent-foreground transition-colors',
            item.className,
          )}
          onClick={item.action}
        >
          {item.icon}
          {item.label}
        </button>
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
