/**
 * EditorSurfaceContext — the seam that keeps the ~600 kB TipTap editor chunk off
 * the cold-start path (#2939).
 *
 * `EditableBlock` renders a block's editing UI (the `EditorContent` portal +
 * the formatting/bubble toolbars) through the component published on this
 * context, rather than importing `@tiptap/react` directly. The heavy
 * `EditorSurface` implementation lives in the lazily-imported editor-runtime
 * chunk (see `RovingEditorHost` / `useLazyRovingEditor`); until that chunk
 * loads, the context value is `null` and `EditableBlock` keeps showing the
 * read-only `StaticBlock`, so pages render their content immediately without
 * parsing or constructing TipTap.
 *
 * This module is intentionally TipTap-free: importing it costs nothing at
 * startup. The `editor` prop is typed loosely (`unknown`) here; the concrete
 * `EditorSurface` re-narrows it to the live TipTap `Editor`.
 */

import { createContext } from 'react'
import type { ComponentType } from 'react'

export interface EditorSurfaceProps {
  /** The live TipTap `Editor` instance for the focused block (never null here). */
  editor: unknown
  blockId: string
  currentPriority: string | null
  /** Whether a file drag is currently hovering the block (renders the drop hint). */
  isDragOver: boolean
}

export type EditorSurfaceComponent = ComponentType<EditorSurfaceProps>

/**
 * Published by `BlockTree` once the lazy editor-runtime chunk has loaded.
 * `null` means "editor runtime not loaded yet" — consumers must fall back to a
 * read-only render.
 */
export const EditorSurfaceContext = createContext<EditorSurfaceComponent | null>(null)
