/**
 * useBlockContextMenu — owns the per-block context-menu position and the
 * editing-key / editing-prop slots that drive the long-press / right-click
 * menu and the inline property editor popover.
 *
 * State:
 * - `contextMenu`: `{ x, y, linkUrl? } | null` — anchor for the floating menu
 * - `editingProp`: `{ key, value } | null` — property currently being edited
 * - `editingKey`:  `{ oldKey, value } | null` — property key currently being renamed
 *
 * Extracted from `SortableBlock` (MAINT-128).
 */

import { useCallback, useState } from 'react'

export interface BlockContextMenuPosition {
  x: number
  y: number
  linkUrl?: string
}

export interface BlockEditingProp {
  key: string
  value: string
}

export interface BlockEditingKey {
  oldKey: string
  value: string
}

export interface UseBlockContextMenuReturn {
  contextMenu: BlockContextMenuPosition | null
  openContextMenu: (x: number, y: number, linkUrl?: string) => void
  closeContextMenu: () => void
  editingProp: BlockEditingProp | null
  setEditingProp: React.Dispatch<React.SetStateAction<BlockEditingProp | null>>
  editingKey: BlockEditingKey | null
  setEditingKey: React.Dispatch<React.SetStateAction<BlockEditingKey | null>>
}

export function useBlockContextMenu(): UseBlockContextMenuReturn {
  const [contextMenu, setContextMenu] = useState<BlockContextMenuPosition | null>(null)
  const [editingProp, setEditingProp] = useState<BlockEditingProp | null>(null)
  const [editingKey, setEditingKey] = useState<BlockEditingKey | null>(null)

  const openContextMenu = useCallback((x: number, y: number, linkUrl?: string) => {
    setContextMenu(linkUrl ? { x, y, linkUrl } : { x, y })
  }, [])

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  return {
    contextMenu,
    openContextMenu,
    closeContextMenu,
    editingProp,
    setEditingProp,
    editingKey,
    setEditingKey,
  }
}
