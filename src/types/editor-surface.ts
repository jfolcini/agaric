/**
 * Shared type-only surface for the lazy-loaded TipTap editor (#2939, #4006).
 *
 * `EditorSurfaceProps`/`EditorSurfaceComponent` describe the shape of the
 * component published on `EditorSurfaceContext` once the editor-runtime
 * chunk has loaded. They live here (rather than alongside the context
 * itself in `@/components/editor/editor-surface-context`) so that
 * `useLazyRovingEditor` — a `hooks/`-tier module — can depend on the type
 * without importing from `components/`, which the lib-layering guard
 * (#3121/#4006) forbids. `src/types/` is out of that guard's scope by
 * design: it is erased at compile time, so importing it never inverts a
 * runtime dependency.
 */

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
